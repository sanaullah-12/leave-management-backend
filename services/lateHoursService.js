/**
 * lateHoursService.js
 * -------------------
 * Late hours, for one employee or for the whole roster.
 *
 * This is a read over the attendance records that already exist. It does not
 * store a total, own a collection, or poll the device: the punches synced by
 * the agent into `attendancelogs` are the only input, and the arrival rule is
 * the one in utils/lateness.js that every other attendance screen already
 * uses. A late total therefore cannot disagree with the day-by-day list an
 * employee is looking at, and cannot be edited into saying something the
 * punches do not support.
 *
 * What counts as a judged day, in one place:
 *   - the first punch of the day is the arrival, exactly as the per-employee
 *     attendance read and the workforce summary already treat it;
 *   - weekends are not judged at all, matching the day-by-day view, where a
 *     weekend is listed but never counted against anyone;
 *   - a day with no punch is not late - it is an absence, a leave day or a
 *     work-from-home day, all of which are somebody else's metric.
 *
 * Late minutes are never charged against a leave balance here or anywhere
 * else. This is an attendance metric on its own.
 */

const AttendanceDbService = require("./attendanceDbService");
const AttendanceSettingsService = require("./AttendanceSettingsService");
const { judgeArrival, formatLateness } = require("../utils/lateness");
const { summariseEntries, emptySummary } = require("../utils/lateHours");
const {
  localDateString,
  localTimeString,
  displayDate,
  displayTime,
} = require("../utils/timezone");

/** Saturday and Sunday, read in UTC so a browser or server zone cannot shift it. */
function isWeekend(dateString) {
  const day = new Date(`${dateString}T00:00:00Z`).getUTCDay();
  return day === 0 || day === 6;
}

/**
 * The office rule as it stands right now, before any per-day adjustment.
 *
 * `previewPolicy` recalculates a response against the other configured arrival
 * time without changing what is stored - the same read-only comparison the
 * attendance page already offers. It can never make someone's own bar easier
 * in the saved record.
 */
async function resolveBasePolicy({ previewPolicy } = {}) {
  const [cutoff, settingsResult] = await Promise.all([
    AttendanceSettingsService.resolveCutoff(null, { previewPolicy }),
    AttendanceSettingsService.getSettings(),
  ]);

  // Read rather than required: the field does not exist in AttendanceSettings
  // yet. Reading it here means adding a grace period later is a schema change
  // and a settings screen, not a change to how lateness is counted.
  const graceMinutes = Number(settingsResult?.settings?.graceMinutes) || 0;

  return {
    cutoffTime: cutoff.cutoffTime,
    policy: cutoff.policy,
    officialCutoffTime: cutoff.officialCutoffTime,
    officialPolicy: cutoff.officialPolicy,
    isPreview: cutoff.isPreview,
    flexibleCutoff: cutoff.flexibleCutoff,
    strictCutoff: cutoff.strictCutoff,
    graceMinutes,
  };
}

/**
 * Which rule one particular day is judged against.
 *
 * Every judged day in this service goes through here, so this is the single
 * place the planned policies plug into:
 *
 *   - grace period          -> already honoured below via graceMinutes
 *   - different start times -> return another cutoffTime for the day
 *   - department schedules  -> branch on employee.department
 *   - shift-based staff     -> branch on the shift covering `date`
 *   - late thresholds       -> a caller filters on the minutes this returns
 *
 * None of those need a second lateness rule, a second total, or a change to
 * any caller: they are all answers to "what was this person's start time on
 * this day", which is what this function returns.
 *
 * @param {{date: string, employee?: object, base: object}} input
 */
function resolveDayPolicy({ date, employee, base }) {
  return {
    date,
    cutoffTime: base.cutoffTime,
    graceMinutes: base.graceMinutes,
    // Named so a later per-department or per-shift answer can say where the
    // time came from without changing the shape a caller reads.
    source: "company",
    employeeId: employee?.employeeId,
  };
}

/**
 * "HH:MM" plus a number of minutes, still "HH:MM".
 * Used to show the effective start time when a grace period is configured.
 */
function shiftClock(cutoffTime, minutes) {
  const [hour, minute] = String(cutoffTime || "")
    .split(":")
    .map(Number);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return cutoffTime;
  const total = hour * 60 + minute + (Number(minutes) || 0);
  const wrapped = ((total % 1440) + 1440) % 1440;
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(Math.floor(wrapped / 60))}:${pad(wrapped % 60)}`;
}

/**
 * Judge one arrival against a resolved day policy.
 *
 * Lateness is measured from the effective start - the office time plus any
 * grace period - so a grace period moves the bar rather than forgiving a
 * quantity of minutes after the fact. With no grace configured this is exactly
 * judgeArrival(), which is what every other screen calls.
 */
function judgeDay(timestamp, dayPolicy) {
  const effectiveCutoff = dayPolicy.graceMinutes
    ? shiftClock(dayPolicy.cutoffTime, dayPolicy.graceMinutes)
    : dayPolicy.cutoffTime;

  const verdict = judgeArrival(timestamp, effectiveCutoff);
  return { ...verdict, effectiveCutoff };
}

/**
 * One judged day, in the shape the daily table renders:
 * date, expected start, punch in, late.
 */
function buildEntry({ timestamp, dayPolicy }) {
  const date = localDateString(timestamp);
  const { isLate, lateMinutes, lateDisplay, effectiveCutoff } = judgeDay(
    timestamp,
    dayPolicy
  );

  return {
    date,
    dateDisplay: displayDate(timestamp),
    /** The rule this day was judged against, as an employee would read it. */
    expected: effectiveCutoff,
    officeCutoff: dayPolicy.cutoffTime,
    graceMinutes: dayPolicy.graceMinutes,
    policySource: dayPolicy.source,
    punchIn: localTimeString(timestamp),
    punchInDisplay: displayTime(timestamp),
    timestamp,
    isLate,
    lateMinutes,
    lateDisplay: lateDisplay || formatLateness(lateMinutes) || null,
  };
}

/** First punch per day for one employee, weekends dropped. */
function firstPunchPerDay(logs) {
  const byDate = new Map();

  for (const log of logs) {
    const date = localDateString(log.timestamp);
    if (isWeekend(date)) continue;

    const existing = byDate.get(date);
    if (!existing || log.timestamp < existing) byDate.set(date, log.timestamp);
  }

  return byDate;
}

/**
 * Late hours for one employee over a range.
 *
 * @param {{employeeId: string|number, startDate: string, endDate: string,
 *          previewPolicy?: string, employee?: object}} input
 */
async function getEmployeeLateHours({
  employeeId,
  startDate,
  endDate,
  previewPolicy,
  employee = null,
}) {
  const base = await resolveBasePolicy({ previewPolicy });

  const logs = await AttendanceDbService.fetchNormalizedLogs({
    employeeIds: [employeeId],
    startDate,
    endDate,
  });

  const punches = firstPunchPerDay(logs);

  const entries = [...punches.entries()]
    .map(([date, timestamp]) =>
      buildEntry({
        timestamp,
        dayPolicy: resolveDayPolicy({ date, employee, base }),
      })
    )
    // Newest first: a late list is read from the most recent day back.
    .sort((a, b) => b.date.localeCompare(a.date));

  return {
    employeeId: String(employeeId),
    dateRange: { from: startDate, to: endDate },
    policy: base,
    summary: summariseEntries(entries, { daysConsidered: entries.length }),
    /** Every judged day, on time ones included, so a table can show both. */
    entries,
    /** The late days alone, which is what the daily late record lists. */
    lateEntries: entries.filter((entry) => entry.lateMinutes > 0),
  };
}

/**
 * Late hours for everyone, in one pass over the range.
 *
 * One read of the collection rather than one per employee: the roster view is
 * opened on a range of months, and a request per person made it unusable.
 *
 * @param {{startDate: string, endDate: string, previewPolicy?: string,
 *          employees?: Array, recentLimit?: number}} input
 */
async function getRosterLateHours({
  startDate,
  endDate,
  previewPolicy,
  employees = [],
  recentLimit = 20,
}) {
  const base = await resolveBasePolicy({ previewPolicy });

  const logs = await AttendanceDbService.fetchNormalizedLogs({
    employeeIds: null,
    startDate,
    endDate,
  });

  const byEmployee = new Map();
  for (const log of logs) {
    if (log.id === undefined) continue;
    const code = String(log.id);
    if (!byEmployee.has(code)) byEmployee.set(code, []);
    byEmployee.get(code).push(log);
  }

  const directory = new Map(
    employees.map((person) => [String(person.employeeId), person])
  );

  const rows = [];
  const allLateEntries = [];

  for (const [code, employeeLogs] of byEmployee.entries()) {
    const person = directory.get(code) || null;
    const punches = firstPunchPerDay(employeeLogs);

    const entries = [...punches.entries()].map(([date, timestamp]) =>
      buildEntry({
        timestamp,
        dayPolicy: resolveDayPolicy({ date, employee: person, base }),
      })
    );

    const summary = summariseEntries(entries, {
      daysConsidered: entries.length,
    });

    rows.push({
      employeeId: code,
      name: person?.name || null,
      department: person?.department || null,
      ...summary,
    });

    entries
      .filter((entry) => entry.lateMinutes > 0)
      .forEach((entry) =>
        allLateEntries.push({
          ...entry,
          employeeId: code,
          name: person?.name || null,
          department: person?.department || null,
        })
      );
  }

  // Worst first: an admin opening this is looking for who to talk to.
  rows.sort((a, b) => b.totalLateMinutes - a.totalLateMinutes);
  allLateEntries.sort((a, b) => b.date.localeCompare(a.date));

  const totals = summariseEntries(allLateEntries, {
    daysConsidered: rows.reduce((sum, row) => sum + row.daysConsidered, 0),
  });

  return {
    dateRange: { from: startDate, to: endDate },
    policy: base,
    /** Company-wide totals over the range. */
    summary: {
      ...totals,
      employeesLate: rows.filter((row) => row.lateDays > 0).length,
      employeesConsidered: rows.length,
    },
    /** Per-employee totals, worst first. */
    employees: rows,
    /** The most recent late arrivals across everyone. */
    recentLateEntries: allLateEntries.slice(0, recentLimit),
  };
}

module.exports = {
  getEmployeeLateHours,
  getRosterLateHours,
  resolveBasePolicy,
  resolveDayPolicy,
  judgeDay,
  buildEntry,
  isWeekend,
  shiftClock,
  emptySummary,
};
