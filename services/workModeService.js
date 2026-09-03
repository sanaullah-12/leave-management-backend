const WorkFromHome = require("../models/WorkFromHome");
const Leave = require("../models/Leave");
const User = require("../models/User");
const { localDateString } = require("../utils/timezone");

/**
 * workModeService
 * ---------------
 * Answers one question for a person and a day: how were they working?
 *
 *   office          a punch on the attendance device
 *   work_from_home  an approved WFH request covering that day
 *   on_leave        an approved leave covering that day
 *   absent          a working day with none of the above
 *
 * This is the seam every other module reads through. Attendance, the dashboard
 * and any future report all ask this service rather than each re-deriving the
 * rule from raw records - so when WFH policies, hybrid schedules or recurring
 * WFH arrive, they change the schedule built here and nothing downstream.
 *
 * Precedence, when a day carries more than one claim:
 *   leave beats WFH   - an approved absence is the stronger statement
 *   schedule beats a punch - an approved WFH day stays WFH even if the person
 *                        dropped into the office, because the approval is what
 *                        was agreed. (Reverse this here if the office ever
 *                        decides the punch should win; nothing else needs to
 *                        change.)
 */

const WORK_MODES = Object.freeze({
  OFFICE: "office",
  WORK_FROM_HOME: "work_from_home",
  ON_LEAVE: "on_leave",
  ABSENT: "absent",
});

const WORK_MODE_LABELS = Object.freeze({
  [WORK_MODES.OFFICE]: "Office",
  [WORK_MODES.WORK_FROM_HOME]: "Work From Home",
  [WORK_MODES.ON_LEAVE]: "On Leave",
  [WORK_MODES.ABSENT]: "Absent",
});

/** The modes that mean the person was working. WFH is one of them. */
const WORKING_MODES = Object.freeze([
  WORK_MODES.OFFICE,
  WORK_MODES.WORK_FROM_HOME,
]);

/** YYYY-MM-DD for a Date, in the office timezone. */
const dayKey = (value) => localDateString(new Date(value));

/** Saturday and Sunday, matching the attendance module's working-day rule. */
const isWeekend = (isoDate) => {
  const [y, m, d] = isoDate.split("-").map(Number);
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return day === 0 || day === 6;
};

/**
 * Every YYYY-MM-DD from start to end inclusive, clamped to the window.
 * Walked in UTC so a day is never skipped or repeated across a DST edge.
 */
const eachDay = (start, end, { from, to } = {}) => {
  const first = from && from > dayKey(start) ? from : dayKey(start);
  const last = to && to < dayKey(end) ? to : dayKey(end);
  if (first > last) return [];

  const days = [];
  const [y, m, d] = first.split("-").map(Number);
  const cursor = new Date(Date.UTC(y, m - 1, d));
  const pad = (n) => String(n).padStart(2, "0");

  for (let guard = 0; guard < 1000; guard += 1) {
    const iso = `${cursor.getUTCFullYear()}-${pad(
      cursor.getUTCMonth() + 1
    )}-${pad(cursor.getUTCDate())}`;
    if (iso > last) break;
    days.push(iso);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
};

/**
 * The approved schedule for a company over a date range.
 *
 * Returns a plain object keyed by the employee's Mongo id:
 *   { "<userId>": { "2026-09-03": "work_from_home", ... } }
 *
 * Only approved records are consulted: a pending request changes nothing about
 * how a day is counted, which is what keeps the approval meaningful.
 *
 * @param {object}  options
 * @param {string}  options.companyId
 * @param {string}  options.startDate  YYYY-MM-DD
 * @param {string}  options.endDate    YYYY-MM-DD
 * @param {Array=}  options.employeeIds  Mongo ids; omit for the whole company
 * @param {boolean=} options.includeLeave  Set false to resolve WFH only
 */
async function getSchedule({
  companyId,
  startDate,
  endDate,
  employeeIds = null,
  includeLeave = true,
}) {
  const schedule = {};
  if (!companyId || !startDate || !endDate) return schedule;

  // Anything that starts before the window ends and ends after it begins.
  const overlaps = {
    company: companyId,
    status: "approved",
    startDate: { $lte: new Date(`${endDate}T23:59:59.999Z`) },
    endDate: { $gte: new Date(`${startDate}T00:00:00.000Z`) },
  };
  if (employeeIds && employeeIds.length) {
    overlaps.employee = { $in: employeeIds };
  }

  const put = (userId, day, mode, { overwrite }) => {
    const key = String(userId);
    const days = (schedule[key] ||= {});
    if (overwrite || !days[day]) days[day] = mode;
  };

  const wfhRequests = await WorkFromHome.find(overlaps)
    .select("employee startDate endDate workMode")
    .lean();

  for (const request of wfhRequests) {
    for (const day of eachDay(request.startDate, request.endDate, {
      from: startDate,
      to: endDate,
    })) {
      put(request.employee, day, request.workMode || WORK_MODES.WORK_FROM_HOME, {
        overwrite: false,
      });
    }
  }

  if (includeLeave) {
    const leaves = await Leave.find(overlaps)
      .select("employee startDate endDate")
      .lean();

    // Leave overwrites: an approved absence outranks an approved WFH day.
    for (const leave of leaves) {
      for (const day of eachDay(leave.startDate, leave.endDate, {
        from: startDate,
        to: endDate,
      })) {
        put(leave.employee, day, WORK_MODES.ON_LEAVE, { overwrite: true });
      }
    }
  }

  return schedule;
}

/**
 * The same schedule, keyed by the code the attendance device knows a person by
 * (User.employeeId) instead of their Mongo id.
 *
 * Attendance records carry only that code, so anything joining attendance to
 * work modes needs this shape. Employees with no code are simply absent from
 * the result rather than an error - they have no device records to join to.
 */
async function getScheduleByEmployeeCode({ companyId, startDate, endDate }) {
  const byUserId = await getSchedule({ companyId, startDate, endDate });
  const ids = Object.keys(byUserId);
  if (!ids.length) return {};

  const users = await User.find({ _id: { $in: ids } })
    .select("employeeId")
    .lean();

  const byCode = {};
  for (const user of users) {
    if (!user.employeeId) continue;
    byCode[String(user.employeeId)] = byUserId[String(user._id)] || {};
  }
  return byCode;
}

/**
 * The mode for one day, given what the schedule says and whether the device
 * saw a punch. The single place the precedence rule lives.
 *
 * @param {string=} scheduled  "work_from_home" | "on_leave" | undefined
 * @param {boolean} hasPunch
 */
function resolveDayMode(scheduled, hasPunch) {
  if (scheduled === WORK_MODES.ON_LEAVE) return WORK_MODES.ON_LEAVE;
  if (scheduled === WORK_MODES.WORK_FROM_HOME) return WORK_MODES.WORK_FROM_HOME;
  return hasPunch ? WORK_MODES.OFFICE : WORK_MODES.ABSENT;
}

/**
 * Counts per mode over a range for one person, given their punch days.
 *
 * Weekends are excluded, matching how the attendance module counts working
 * days, so the four counts add up to the working days in the range.
 *
 * @param {object} options
 * @param {object} options.days      { "YYYY-MM-DD": "work_from_home" | "on_leave" }
 * @param {Set}    options.punchDays Set of YYYY-MM-DD the device recorded
 * @param {string} options.startDate YYYY-MM-DD
 * @param {string} options.endDate   YYYY-MM-DD
 */
function summariseRange({ days = {}, punchDays = new Set(), startDate, endDate }) {
  const counts = {
    [WORK_MODES.OFFICE]: 0,
    [WORK_MODES.WORK_FROM_HOME]: 0,
    [WORK_MODES.ON_LEAVE]: 0,
    [WORK_MODES.ABSENT]: 0,
  };

  const [y, m, d] = startDate.split("-").map(Number);
  const cursor = new Date(Date.UTC(y, m - 1, d));
  const pad = (n) => String(n).padStart(2, "0");

  for (let guard = 0; guard < 1000; guard += 1) {
    const iso = `${cursor.getUTCFullYear()}-${pad(
      cursor.getUTCMonth() + 1
    )}-${pad(cursor.getUTCDate())}`;
    if (iso > endDate) break;
    if (!isWeekend(iso)) {
      counts[resolveDayMode(days[iso], punchDays.has(iso))] += 1;
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return counts;
}

module.exports = {
  WORK_MODES,
  WORK_MODE_LABELS,
  WORKING_MODES,
  getSchedule,
  getScheduleByEmployeeCode,
  resolveDayMode,
  summariseRange,
  // Exported for the routes that need the same day arithmetic, and for tests.
  helpers: { eachDay, dayKey, isWeekend },
};
