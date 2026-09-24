/**
 * attendanceCorrectionService.js
 * ------------------------------
 * The effective arrival of an employee-day, in one place.
 *
 * Every attendance read picks the first device punch of a day as the arrival
 * and hands it to judgeArrival() in utils/lateness.js. This service sits
 * between those two steps: given the machine arrival, it returns the arrival
 * the day is actually judged by, which is the approved corrected time when an
 * admin has approved one and the machine time otherwise.
 *
 * The rule:
 *   - only an APPROVED correction changes anything; pending and rejected ones
 *     are shown to people but never counted;
 *   - a correction only ever moves an arrival earlier. If the device later
 *     turns up an even earlier punch for the day, that punch wins;
 *   - the device record is never touched. Callers keep the machine time
 *     alongside the effective one so both can be shown.
 *
 * Callers load the approved corrections for their range once, with
 * loadApprovedCorrections(), then call resolveArrival() per employee-day. That
 * keeps a month-long roster read at one extra indexed query.
 */

const AttendanceCorrection = require("../models/AttendanceCorrection");
const {
  zonedTimeToInstant,
  displayTime,
  localDateString,
} = require("../utils/timezone");

const keyOf = (employeeCode, date) => `${employeeCode}|${date}`;

/** "HH:MM" on an office calendar day, as the instant it denotes. */
function instantFor(date, hhmm) {
  const [year, month, day] = String(date).split("-").map(Number);
  const [hour, minute] = String(hhmm).split(":").map(Number);
  return zonedTimeToInstant(year, month, day, hour, minute, 0, 0);
}

/**
 * Approved corrections over a range, keyed by `${employeeCode}|${date}`.
 *
 * @param {{companyId?: *, employeeCodes?: Array|null, startDate: string, endDate: string}} input
 *   Omit employeeCodes (or pass null) for everyone.
 */
async function loadApprovedCorrections({
  companyId = null,
  employeeCodes = null,
  startDate,
  endDate,
}) {
  const query = {
    status: "approved",
    date: { $gte: startDate, $lte: endDate },
  };
  if (companyId) query.company = companyId._id || companyId;
  if (Array.isArray(employeeCodes)) {
    query.employeeCode = { $in: employeeCodes.map(String) };
  }

  const docs = await AttendanceCorrection.find(query)
    .select("employeeCode date requestedTime requestedCheckIn machineCheckIn reviewedAt")
    .lean();

  return new Map(docs.map((doc) => [keyOf(doc.employeeCode, doc.date), doc]));
}

/**
 * The arrival one employee-day is judged by.
 *
 * @param {Map} corrections  From loadApprovedCorrections()
 * @param {string|number} employeeCode
 * @param {string} date      YYYY-MM-DD, office calendar
 * @param {Date} machineAt   The first device punch of the day
 * @returns {{at: Date, machineAt: Date, corrected: boolean, correction: object|null}}
 */
function resolveArrival(corrections, employeeCode, date, machineAt) {
  const correction =
    corrections && corrections.get(keyOf(String(employeeCode), date));

  if (!correction || !machineAt) {
    return { at: machineAt, machineAt, corrected: false, correction: null };
  }

  const approvedAt = new Date(correction.requestedCheckIn);
  if (!(approvedAt < machineAt)) {
    return { at: machineAt, machineAt, corrected: false, correction: null };
  }

  return { at: approvedAt, machineAt, corrected: true, correction };
}

/**
 * For callers that judge punches one at a time rather than one arrival per
 * day: a function giving the instant each punch should be judged at. Only the
 * first punch of a day can be replaced, and only by an approved correction.
 *
 * @param {Array<{timestamp: Date|string}>} logs  One employee's punches
 * @returns {(log: {timestamp: Date|string}) => Date}
 */
function effectivePunchTimes(logs, employeeCode, corrections) {
  const firstByDay = new Map();
  for (const log of logs) {
    const at = new Date(log.timestamp);
    if (Number.isNaN(at.getTime())) continue;
    const day = localDateString(at);
    const seen = firstByDay.get(day);
    if (!seen || at < seen) firstByDay.set(day, at);
  }

  const replaced = new Map();
  for (const [day, first] of firstByDay) {
    const arrival = resolveArrival(corrections, employeeCode, day, first);
    if (arrival.corrected) replaced.set(first.getTime(), arrival.at);
  }

  return (log) => {
    const at = new Date(log.timestamp);
    return replaced.get(at.getTime()) || at;
  };
}

/**
 * The fields a row carries when its arrival was corrected, so every screen can
 * say "corrected from 09:47" the same way.
 */
function correctionFields(arrival) {
  if (!arrival || !arrival.corrected) return { timeCorrected: false };
  return {
    timeCorrected: true,
    machineCheckInAt: arrival.machineAt.toISOString(),
    machineCheckInDisplay: displayTime(arrival.machineAt),
    correctionId: String(arrival.correction._id),
  };
}

/**
 * The latest live-or-decided request per day for one employee, for showing a
 * request's status next to its day. Cancelled requests are left out.
 *
 * @returns {Promise<Map<string, object>>} date -> request summary
 */
async function loadRequestsByDay({ companyId, employeeCode, startDate, endDate }) {
  const docs = await AttendanceCorrection.find({
    company: companyId._id || companyId,
    employeeCode: String(employeeCode),
    date: { $gte: startDate, $lte: endDate },
    status: { $ne: "cancelled" },
  })
    .sort({ createdAt: 1 })
    .select("date status requestedTime machineCheckIn reviewComments createdAt")
    .lean();

  const byDay = new Map();
  for (const doc of docs) {
    byDay.set(doc.date, {
      id: String(doc._id),
      status: doc.status,
      requestedTime: doc.requestedTime,
      reviewComments: doc.reviewComments || "",
    });
  }
  return byDay;
}

module.exports = {
  keyOf,
  instantFor,
  loadApprovedCorrections,
  resolveArrival,
  effectivePunchTimes,
  correctionFields,
  loadRequestsByDay,
};
