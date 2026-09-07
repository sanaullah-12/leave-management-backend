/**
 * lateArrivalNotifier.js
 * ----------------------
 * Turns a freshly ingested punch into a late-arrival notification.
 *
 * It computes nothing of its own. The start time comes from
 * AttendanceSettingsService (the admin's configured flexible/strict/custom
 * arrival time), the verdict from lateHoursService, and the running total from
 * the same derived summary the Late Time page renders. So a notification can
 * never claim a number the employee cannot find in the app - there is one
 * arithmetic, and this only reports it.
 *
 *   agent pushes punches -> AttendanceSyncService.persistDeviceLogs
 *                             |
 *                        notifyForLogs()
 *                             |
 *                  NotificationService.dispatch(ATTENDANCE_LATE_ARRIVAL)
 *                             |
 *                +------------+------------+
 *                |                         |
 *          in-app + Socket.IO        browser push
 *
 * Two guards keep it from ever becoming noise, and both matter more than the
 * feature itself:
 *
 *   1. At most one notification per employee per day, enforced by a dedupe key
 *      that is also a unique index. Attendance is re-read on every sync - the
 *      same punch is seen again ten minutes later - so without this the
 *      employee would be told they were late every ten minutes all day.
 *
 *   2. Only recent days are notified. A historical backfill re-imports months
 *      of punches at once; telling somebody they were late on a morning in
 *      March is not a notification, it is an accident.
 */

const { NotificationService, NOTIFICATION_EVENTS } = require("../notifications");
const lateHoursService = require("./lateHoursService");
const Notification = require("../models/Notification");
const User = require("../models/User");
const { localDateString } = require("../utils/timezone");

/**
 * The period "accumulated late time" adds up.
 *
 * Month to date by default: a total that never resets grows without meaning,
 * and the calendar month is the period the rest of HR already works in. This is
 * the accumulation window only - it has no bearing on which time an arrival is
 * judged against, which stays entirely with AttendanceSettingsService.
 */
const ACCUMULATION_PERIOD = String(
  process.env.LATE_ACCUMULATION_PERIOD || "month"
).toLowerCase();

/**
 * How stale a punch may be and still be worth a notification.
 *
 * One day by default, so today and a punch that arrived just after midnight are
 * covered and a re-import of last quarter is not.
 */
const MAX_AGE_DAYS = Number.isFinite(
  parseInt(process.env.LATE_NOTIFY_MAX_AGE_DAYS, 10)
)
  ? parseInt(process.env.LATE_NOTIFY_MAX_AGE_DAYS, 10)
  : 1;

/** Off by default is wrong here - but so is surprising an operator. */
const ENABLED = String(process.env.LATE_ARRIVAL_NOTIFICATIONS || "true")
  .trim()
  .toLowerCase() !== "false";

/** Where the accumulation window starts for a punch on `date`. */
function accumulationStart(date) {
  if (ACCUMULATION_PERIOD === "all") return "1970-01-01";
  if (ACCUMULATION_PERIOD === "year") return `${date.slice(0, 4)}-01-01`;
  return `${date.slice(0, 7)}-01`;
}

/**
 * At-most-once, per employee per day.
 * Also the push collapse tag, so a retry replaces rather than stacks.
 */
const dedupeKeyFor = (userId, date) => `late:${userId}:${date}`;

/** Days between two YYYY-MM-DD strings, read in UTC so no zone can shift it. */
function daysBetween(from, to) {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return Infinity;
  return Math.round((b - a) / 86400000);
}

/**
 * The (employee, day) pairs worth judging out of a batch of punches.
 *
 * Weekends are dropped here for the same reason lateHoursService drops them:
 * a day nobody is expected to attend cannot be attended late.
 */
function candidatesFrom(logs, today) {
  const pairs = new Map();

  for (const log of logs || []) {
    const code = log.userId ?? log.employeeId ?? log.id;
    if (code === undefined || code === null || code === "") continue;

    const timestamp = log.timestamp instanceof Date ? log.timestamp : new Date(log.timestamp);
    if (Number.isNaN(timestamp.getTime())) continue;

    const date = localDateString(timestamp);
    if (lateHoursService.isWeekend(date)) continue;
    if (daysBetween(date, today) > MAX_AGE_DAYS) continue;
    // A punch dated in the future is a clock fault, not an arrival.
    if (daysBetween(today, date) > 0) continue;

    pairs.set(`${code}|${date}`, { code: String(code), date });
  }

  return [...pairs.values()];
}

/**
 * Judge one employee-day and notify if it was late.
 * Resolves to a short outcome string; never throws.
 */
async function notifyOne({ user, code, date }) {
  const dedupeKey = dedupeKeyFor(String(user._id), date);

  // Cheap pre-check. The unique index is what actually guarantees at-most-once
  // when two syncs overlap; this just avoids the work in the common case.
  if (await Notification.exists({ dedupeKey })) return "already_notified";

  const employee = { employeeId: code, name: user.name, department: user.department };

  // The verdict first, over that one day only. Most people are on time, and an
  // on-time day must not cost a month-wide read on every sync of the day.
  const today = await lateHoursService.getEmployeeLateHours({
    employeeId: code,
    startDate: date,
    endDate: date,
    employee,
  });

  const entry = today.entries.find((candidate) => candidate.date === date);
  if (!entry) return "no_punch";
  if (!entry.isLate || entry.lateMinutes < 1) return "on_time";

  // Only a late day pays for the accumulation window.
  const result = await lateHoursService.getEmployeeLateHours({
    employeeId: code,
    startDate: accumulationStart(date),
    endDate: date,
    employee,
  });

  await NotificationService.dispatch({
    event: NOTIFICATION_EVENTS.ATTENDANCE_LATE_ARRIVAL,
    companyId: user.company,
    userId: user._id,
    dedupeKey,
    payload: {
      employeeName: user.name,
      employeeId: code,
      date,
      // The configured start time this day was judged against, so the message
      // can always be traced back to the rule that produced it.
      expected: entry.expected,
      punchIn: entry.punchInDisplay || entry.punchIn,
      lateMinutes: entry.lateMinutes,
      lateDisplay: entry.lateDisplay,
      totalLateMinutes: result.summary.totalLateMinutes,
      totalLateDisplay: result.summary.totalLateDisplay,
      lateDays: result.summary.lateDays,
      accumulationFrom: result.dateRange.from,
      policy: result.policy.policy,
    },
  });

  return "notified";
}

/**
 * Notify about every late arrival in a batch of freshly ingested punches.
 *
 * Fail-safe by contract: attendance ingestion has already succeeded by the time
 * this runs, and a notification problem must never turn a stored punch into a
 * failed sync. Everything is caught and logged.
 *
 * @param {Array} logs Device logs as the agent posts them.
 * @param {{companyId?: string}} context
 * @returns {Promise<object>} Counts per outcome, for logging and tests.
 */
async function notifyForLogs(logs, context = {}) {
  const summary = { considered: 0, notified: 0, onTime: 0, skipped: 0, failed: 0 };

  if (!ENABLED || !Array.isArray(logs) || logs.length === 0) return summary;

  try {
    const today = localDateString(new Date());
    const candidates = candidatesFrom(logs, today);
    if (!candidates.length) return summary;

    summary.considered = candidates.length;

    // One lookup for the whole batch rather than one per punch.
    const codes = [...new Set(candidates.map((candidate) => candidate.code))];
    const users = await User.find({
      employeeId: { $in: codes },
      ...(context.companyId ? { company: context.companyId } : {}),
      isActive: { $ne: false },
      status: "active",
    })
      .select("_id name employeeId department company")
      .lean();

    const byCode = new Map(users.map((user) => [String(user.employeeId), user]));

    for (const candidate of candidates) {
      const user = byCode.get(candidate.code);
      // A device code with no active account is normal - a departed employee,
      // or an enrolment nobody has linked yet. There is nobody to notify.
      if (!user) {
        summary.skipped += 1;
        continue;
      }

      try {
        const outcome = await notifyOne({ user, ...candidate });
        if (outcome === "notified") summary.notified += 1;
        else if (outcome === "on_time") summary.onTime += 1;
        else summary.skipped += 1;
      } catch (error) {
        // The unique index rejecting a concurrent duplicate is the guard doing
        // its job, not a fault worth logging as one.
        if (error?.code === 11000) {
          summary.skipped += 1;
          continue;
        }
        summary.failed += 1;
        console.error(
          `Late-arrival notification failed for employee ${candidate.code} on ${candidate.date}:`,
          error.message
        );
      }
    }

    if (summary.notified) {
      console.log(
        `Late arrivals notified: ${summary.notified} of ${summary.considered} judged ` +
          `(${summary.onTime} on time, ${summary.skipped} skipped)`
      );
    }
  } catch (error) {
    summary.failed += 1;
    console.error("Late-arrival notification pass failed:", error.message);
  }

  return summary;
}

/**
 * Judge one employee-day on demand, ignoring the freshness guard.
 *
 * For an admin re-running a day, and for tests: it is the same path a real
 * punch takes, so a passing test here is evidence about production behaviour
 * rather than about a parallel implementation.
 */
async function notifyForEmployeeDay({ employeeCode, date, companyId }) {
  const user = await User.findOne({
    employeeId: String(employeeCode),
    ...(companyId ? { company: companyId } : {}),
  })
    .select("_id name employeeId department company")
    .lean();

  if (!user) return "no_user";
  return notifyOne({ user, code: String(employeeCode), date });
}

module.exports = {
  notifyForLogs,
  notifyForEmployeeDay,
  dedupeKeyFor,
  accumulationStart,
  // Exported so the documentation and the settings screen can state the window
  // rather than restating the default in a second place.
  ACCUMULATION_PERIOD,
  MAX_AGE_DAYS,
};
