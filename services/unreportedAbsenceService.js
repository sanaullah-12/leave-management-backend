const Leave = require("../models/Leave");
const User = require("../models/User");
const WorkFromHome = require("../models/WorkFromHome");
const AttendanceLog = require("../models/AttendanceLog");
const AttendanceSettings = require("../models/AttendanceSettings");
const AbsenceRuleRun = require("../models/AbsenceRuleRun");
const SocketService = require("../socket/socketService");
const { NotificationService, NOTIFICATION_EVENTS } = require("../notifications");
const {
  localDateString,
  localDayRange,
  zonedParts,
  today,
} = require("../utils/timezone");

/**
 * unreportedAbsenceService
 * ------------------------
 * The office rule for a day nobody accounted for.
 *
 * After the cutoff (14:00 by default) on a working day, an employee with no
 * punch, no leave and no work-from-home request has told nobody anything. The
 * day is recorded as annual leave, with a reason saying exactly that, so the
 * absence lands in the leave record instead of sitting in attendance as an
 * unexplained gap.
 *
 * Three properties make this safe to run automatically:
 *
 *   Reversible. The leave is flagged `isAutoMarked`, and approving a backdated
 *   work-from-home request for those days revokes it and returns the balance.
 *   Someone who worked from home and forgot to say so is not punished twice.
 *   Punches that arrive after the rule ran - the agent was started a day late -
 *   revoke it the same way (revokeForArrivedAttendance).
 *
 *   Patient. A day with no attendance from anyone is not judged at all, and is
 *   recorded as awaiting attendance. When the agent next delivers that day's
 *   punches, catchUpAwaitingDays judges it on them, so an employee who really
 *   was absent is still charged and nobody who was present ever is.
 *
 *   Idempotent. A day already carrying an auto-marked leave is skipped, so the
 *   scheduler can run as often as it likes and a manual re-run costs nothing.
 *
 *   Conservative. Anything that looks like the employee did communicate - a
 *   pending request, a pending leave, a single punch - stops the rule. Only
 *   silence is charged.
 */

const AUTO_MARK_SOURCE = "unreported_absence";

const DEFAULT_POLICY = Object.freeze({
  enabled: true,
  cutoffTime: "14:00",
  leaveType: "annual",
  fallbackLeaveType: "unpaid",
});

/** Minutes past midnight for "HH:MM". */
const toMinutes = (value) => {
  const [h, m] = String(value || "").split(":").map(Number);
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null;
};

const isWeekend = (isoDate) => {
  const [y, m, d] = isoDate.split("-").map(Number);
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return day === 0 || day === 6;
};

/** The UTC-midnight instant for a YYYY-MM-DD, matching how leave is stored. */
const dayStart = (isoDate) => new Date(`${isoDate}T00:00:00.000Z`);
const dayEnd = (isoDate) => new Date(`${isoDate}T23:59:59.999Z`);

/** The office rule, falling back to the defaults when unset. */
async function getPolicy() {
  try {
    const settings = await AttendanceSettings.getSettings();
    const stored = settings?.unreportedAbsenceSettings;
    if (!stored) return { ...DEFAULT_POLICY };
    return {
      enabled: stored.enabled ?? DEFAULT_POLICY.enabled,
      cutoffTime: stored.cutoffTime || DEFAULT_POLICY.cutoffTime,
      leaveType: stored.leaveType || DEFAULT_POLICY.leaveType,
      fallbackLeaveType:
        stored.fallbackLeaveType || DEFAULT_POLICY.fallbackLeaveType,
    };
  } catch (error) {
    console.error("Unreported absence policy unavailable:", error.message);
    return { ...DEFAULT_POLICY };
  }
}

/** Whether the office clock has passed the cutoff on the given day. */
function cutoffHasPassed(isoDate, cutoffTime) {
  if (isoDate < today()) return true; // any earlier day is fully over
  if (isoDate > today()) return false;

  const { hour, minute } = zonedParts(new Date());
  const now = Number(hour) * 60 + Number(minute);
  const cutoff = toMinutes(cutoffTime);
  return cutoff == null ? false : now >= cutoff;
}

/**
 * Applies the rule to one day for one company.
 *
 * @param {object}  options
 * @param {string}  options.companyId
 * @param {string}  options.date      YYYY-MM-DD
 * @param {boolean=} options.dryRun   Report what would happen, write nothing
 * @param {boolean=} options.force    Ignore the cutoff (a manual admin run)
 * @param {boolean=} options.catchUp  The day is being judged after the fact
 * @returns {Promise<object>} A report: marked, skipped and why
 */
async function markUnreportedAbsences({
  companyId,
  date,
  dryRun = false,
  force = false,
  catchUp = false,
}) {
  const policy = await getPolicy();
  const report = {
    date,
    policy,
    ran: false,
    reason: null,
    marked: [],
    skipped: [],
  };

  if (!policy.enabled) {
    report.reason = "The unreported absence rule is disabled";
    return report;
  }
  if (isWeekend(date)) {
    report.reason = "Not a working day";
    return report;
  }
  // A day nobody has lived through cannot be an unreported absence. `force`
  // exists to re-run a day the server was down for, never to charge one that
  // has not happened - so it does not bypass this.
  if (date > today()) {
    report.reason = "That day has not happened yet";
    return report;
  }
  if (!force && !cutoffHasPassed(date, policy.cutoffTime)) {
    report.reason = `Before the ${policy.cutoffTime} cutoff`;
    return report;
  }

  report.ran = true;

  const employees = await User.find({
    company: companyId,
    role: "employee",
    status: "active",
    isActive: true,
  }).select("_id name employeeId leaveQuota");

  if (!employees.length) return report;

  // Leave and work-from-home are stored at UTC midnight of the day they cover;
  // punches are real instants, so they are matched against the office's own
  // calendar day - the same day revokeForArrivedAttendance files them under.
  const from = dayStart(date);
  const to = dayEnd(date);
  const punchWindow = localDayRange(date, date);
  const ids = employees.map((e) => e._id);
  const codes = employees.map((e) => e.employeeId).filter(Boolean);

  // Everything that counts as "they told us", gathered in three reads rather
  // than three per employee.
  const [punches, wfhRequests, leaves] = await Promise.all([
    AttendanceLog.find({
      employeeId: { $in: codes },
      timestamp: { $gte: punchWindow.start, $lte: punchWindow.end },
    })
      .select("employeeId")
      .lean(),
    WorkFromHome.find({
      employee: { $in: ids },
      status: { $in: ["pending", "approved"] },
      startDate: { $lte: to },
      endDate: { $gte: from },
    })
      .select("employee")
      .lean(),
    Leave.find({
      employee: { $in: ids },
      status: { $in: ["pending", "approved"] },
      startDate: { $lte: to },
      endDate: { $gte: from },
    })
      .select("employee isAutoMarked")
      .lean(),
  ]);

  // Not one punch from anyone on a working day means the attendance feed is
  // down (agent stopped, device unreachable), not that the whole office stayed
  // home. Charging that day would put every employee who was present on leave,
  // which is what happened on 2 and 5 October 2026. No leave is written; the
  // day is set aside as awaiting attendance and judged on real punches once
  // the agent delivers them, whether later today or days from now.
  if (!punches.length) {
    report.ran = false;
    report.attendanceMissing = true;
    report.reason =
      "No attendance has arrived for anyone on this day; the attendance feed is likely down, so nobody was charged";
    if (!dryRun) {
      // $setOnInsert: a day already judged stays judged.
      await AbsenceRuleRun.updateOne(
        { company: companyId, date },
        { $setOnInsert: { status: "awaiting_attendance" } },
        { upsert: true }
      );
    }
    return report;
  }

  const punched = new Set(punches.map((p) => String(p.employeeId)));
  const requestedWfh = new Set(wfhRequests.map((r) => String(r.employee)));
  const onLeave = new Set(leaves.map((l) => String(l.employee)));

  for (const employee of employees) {
    const key = String(employee._id);
    const note = (why) =>
      report.skipped.push({
        employeeId: employee.employeeId,
        name: employee.name,
        reason: why,
      });

    // An auto-marked leave for this day means the rule already ran.
    if (onLeave.has(key)) {
      const existing = leaves.find((l) => String(l.employee) === key);
      note(existing?.isAutoMarked ? "Already recorded by this rule" : "On leave");
      continue;
    }
    if (employee.employeeId && punched.has(String(employee.employeeId))) {
      note("Attendance recorded");
      continue;
    }
    if (requestedWfh.has(key)) {
      note("Work from home requested");
      continue;
    }

    // Charge the configured type while it has balance; fall back rather than
    // write a negative one. An employee out of annual leave still has to be
    // accounted for.
    let leaveType = policy.leaveType;
    let isFallback = false;
    try {
      const balance = await employee.getLeaveBalance(policy.leaveType);
      if ((balance?.remaining ?? 0) < 1) {
        leaveType = policy.fallbackLeaveType;
        isFallback = true;
      }
    } catch (error) {
      console.error(
        `Balance lookup failed for ${employee.employeeId}:`,
        error.message
      );
    }

    const reason = `No attendance recorded and no work from home or leave request received before ${policy.cutoffTime}. Recorded automatically as ${leaveType} leave.`;

    if (dryRun) {
      report.marked.push({
        employeeId: employee.employeeId,
        name: employee.name,
        leaveType,
        isFallback,
        reason,
      });
      continue;
    }

    try {
      const leave = new Leave({
        employee: employee._id,
        company: companyId,
        leaveType,
        startDate: from,
        endDate: from,
        totalDays: 1,
        reason,
        status: "approved",
        appliedDate: new Date(),
        reviewedDate: new Date(),
        reviewComments: "Recorded automatically by the unreported absence rule",
        isAutoMarked: true,
        autoMarkSource: AUTO_MARK_SOURCE,
        autoMarkedAt: new Date(),
      });
      await leave.save();

      report.marked.push({
        employeeId: employee.employeeId,
        name: employee.name,
        leaveId: leave._id,
        leaveType,
        isFallback,
        reason,
      });

      SocketService.toUser(
        employee._id,
        SocketService.events.LEAVE_AUTO_MARKED,
        { leaveId: leave._id, date, leaveType }
      );

      // The employee has to be told - a leave day was taken from them by a
      // rule, and they are the only one who can say it was wrong.
      try {
        await NotificationService.dispatch({
          event: NOTIFICATION_EVENTS.LEAVE_AUTO_MARKED,
          companyId,
          refs: { leaveId: leave._id },
          recipients: [{ _id: employee._id, preferences: {} }],
          payload: {
            leaveType,
            startDate: from,
            endDate: from,
            totalDays: 1,
            cutoffTime: policy.cutoffTime,
            isFallback,
          },
        });
      } catch (error) {
        console.error(
          `Auto-leave notification failed for ${employee.employeeId}:`,
          error.message
        );
      }
    } catch (error) {
      console.error(
        `Auto-marking failed for ${employee.employeeId}:`,
        error.message
      );
      note(`Failed: ${error.message}`);
    }
  }

  if (!dryRun) {
    await AbsenceRuleRun.updateOne(
      { company: companyId, date },
      {
        $set: {
          status: "judged",
          judgedAt: new Date(),
          marked: report.marked.length,
          catchUp,
        },
      },
      { upsert: true }
    );
  }

  if (report.marked.length && !dryRun) {
    SocketService.toCompanyAdmins(
      companyId,
      SocketService.events.LEAVE_AUTO_MARKED,
      { date, count: report.marked.length }
    );
    SocketService.statsUpdate(companyId, "dashboard");
  }

  return report;
}

/** How far back a day set aside for missing attendance is still judged. */
const CATCH_UP_DAYS = 31;

/**
 * Quiet time after a day's last punch landed before the day is judged. The
 * agent delivers in batches; judging between two of them would charge people
 * whose punches are in the next one.
 */
const UPLOAD_SETTLE_MS = 15 * 60 * 1000;

/**
 * Judges the earlier days the rule set aside because no attendance had arrived.
 *
 * The agent not running on a day means its punches reach the server only when
 * it is next started, and from then on the day can be judged like any other:
 * whoever punched was present, whoever has leave or work from home is covered,
 * and only the rest are charged. A day whose punches are still missing stays
 * set aside, and one still being uploaded waits for the next pass.
 *
 * Today is left to the scheduler's own daily run.
 *
 * @returns {Promise<Array<object>>} One report per day judged
 */
async function catchUpAwaitingDays() {
  const current = today();
  const [y, m, d] = current.split("-").map(Number);
  const oldest = new Date(Date.UTC(y, m - 1, d - CATCH_UP_DAYS))
    .toISOString()
    .slice(0, 10);

  const awaiting = await AbsenceRuleRun.find({
    status: "awaiting_attendance",
    date: { $gte: oldest, $lt: current },
  })
    .sort({ date: 1 })
    .lean();

  const reports = [];
  for (const run of awaiting) {
    const window = localDayRange(run.date, run.date);
    const latest = await AttendanceLog.findOne({
      company: run.company,
      timestamp: { $gte: window.start, $lte: window.end },
    })
      .sort({ syncedAt: -1 })
      .select("syncedAt")
      .lean();

    if (!latest) continue;
    if (latest.syncedAt && Date.now() - latest.syncedAt.getTime() < UPLOAD_SETTLE_MS) {
      continue;
    }

    try {
      const report = await markUnreportedAbsences({
        companyId: run.company,
        date: run.date,
        catchUp: true,
      });
      reports.push({ companyId: run.company, ...report });
    } catch (error) {
      console.error(
        `Catch-up of unreported absences failed for ${run.date}:`,
        error.message
      );
    }
  }
  return reports;
}

/**
 * Revokes auto-marked leave covering a range, returning those days.
 *
 * Called when an approved work-from-home request proves the employee was
 * working after all. Only leave this rule created is ever removed - a leave
 * somebody actually applied for is untouched.
 *
 * @returns {Promise<{ removed: number, days: number, leaveTypes: string[] }>}
 */
async function revokeAutoMarkedLeave({
  employeeId,
  companyId,
  startDate,
  endDate,
  notify = true,
}) {
  const from = startDate instanceof Date ? startDate : dayStart(startDate);
  const to = endDate instanceof Date ? new Date(endDate) : dayEnd(endDate);
  to.setUTCHours(23, 59, 59, 999);

  const stale = await Leave.find({
    employee: employeeId,
    isAutoMarked: true,
    status: { $ne: "rejected" },
    startDate: { $lte: to },
    endDate: { $gte: from },
  });

  if (!stale.length) return { removed: 0, days: 0, leaveTypes: [] };

  const days = stale.reduce((sum, l) => sum + (l.totalDays || 1), 0);
  const leaveTypes = [...new Set(stale.map((l) => l.leaveType))];

  await Leave.deleteMany({ _id: { $in: stale.map((l) => l._id) } });

  if (notify) {
    SocketService.toUser(
      employeeId,
      SocketService.events.LEAVE_REVIEWED,
      { reversed: true, days }
    );
    try {
      await NotificationService.dispatch({
        event: NOTIFICATION_EVENTS.LEAVE_AUTO_REVERSED,
        companyId,
        recipients: [{ _id: employeeId, preferences: {} }],
        payload: {
          leaveType: leaveTypes[0],
          startDate: stale[0].startDate,
          endDate: stale[stale.length - 1].endDate,
          totalDays: days,
        },
      });
    } catch (error) {
      console.error("Auto-leave reversal notification failed:", error.message);
    }
  }

  return { removed: stale.length, days, leaveTypes };
}

/**
 * Revokes auto-marked leave for days the given punches prove were worked.
 *
 * The rule can only judge the punches that have arrived by the time it runs.
 * When the agent was not running that day, the punches reach the server only
 * once it is started again - a day or more later - and by then every employee
 * who was present has been charged. Every stored punch passes through here, so
 * those days are returned as soon as the attendance that proves them lands,
 * with nobody having to re-run anything.
 *
 * A punch at any time on the employee's local calendar day counts: they were
 * at work that day, so the day was not an unreported absence. Only leave this
 * rule created is touched, and re-sending punches already handled costs one
 * read and changes nothing.
 *
 * @param {object} options
 * @param {string} options.companyId
 * @param {Array<{ employeeId: string, timestamp: Date }>} options.logs
 * @returns {Promise<{ revoked: Array<{ employeeId: string, name: string, date: string }> }>}
 */
async function revokeForArrivedAttendance({ companyId, logs }) {
  const daysByCode = new Map();
  for (const log of logs || []) {
    const time = log?.timestamp instanceof Date ? log.timestamp : new Date(log?.timestamp);
    if (!log?.employeeId || Number.isNaN(time.getTime())) continue;
    const code = String(log.employeeId);
    if (!daysByCode.has(code)) daysByCode.set(code, new Set());
    daysByCode.get(code).add(localDateString(time));
  }
  if (!daysByCode.size) return { revoked: [] };

  const employees = await User.find({
    company: companyId,
    employeeId: { $in: [...daysByCode.keys()] },
  })
    .select("_id employeeId name")
    .lean();
  if (!employees.length) return { revoked: [] };

  const allDays = [...daysByCode.values()].flatMap((days) => [...days]).sort();
  const leaves = await Leave.find({
    employee: { $in: employees.map((e) => e._id) },
    isAutoMarked: true,
    autoMarkSource: AUTO_MARK_SOURCE,
    status: { $ne: "rejected" },
    startDate: { $lte: dayEnd(allDays[allDays.length - 1]) },
    endDate: { $gte: dayStart(allDays[0]) },
  })
    .select("employee startDate")
    .lean();

  const employeeById = new Map(employees.map((e) => [String(e._id), e]));
  const revoked = [];

  for (const leave of leaves) {
    const employee = employeeById.get(String(leave.employee));
    // Auto-marked leave is stored at UTC midnight of the local day it charges.
    const date = new Date(leave.startDate).toISOString().slice(0, 10);
    if (!employee || !daysByCode.get(String(employee.employeeId))?.has(date)) {
      continue;
    }

    try {
      const result = await revokeAutoMarkedLeave({
        employeeId: employee._id,
        companyId,
        startDate: date,
        endDate: date,
      });
      if (result.removed) {
        revoked.push({ employeeId: employee.employeeId, name: employee.name, date });
      }
    } catch (error) {
      console.error(
        `Revoking auto-marked leave failed for ${employee.employeeId} on ${date}:`,
        error.message
      );
    }
  }

  if (revoked.length) SocketService.statsUpdate(companyId, "dashboard");

  return { revoked };
}

/** Applies the rule to every company for a given day. */
async function runForAllCompanies({ date = null, dryRun = false } = {}) {
  const Company = require("../models/Company");
  const day = date || localDateString(new Date());
  const companies = await Company.find().select("_id name").lean();

  const reports = [];
  for (const company of companies) {
    reports.push({
      company: company.name,
      ...(await markUnreportedAbsences({
        companyId: company._id,
        date: day,
        dryRun,
      })),
    });
  }
  return reports;
}

module.exports = {
  AUTO_MARK_SOURCE,
  DEFAULT_POLICY,
  getPolicy,
  cutoffHasPassed,
  markUnreportedAbsences,
  catchUpAwaitingDays,
  revokeAutoMarkedLeave,
  revokeForArrivedAttendance,
  runForAllCompanies,
};
