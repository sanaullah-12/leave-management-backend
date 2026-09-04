const { zonedParts } = require("./timezone");

/**
 * lateness.js
 * -----------
 * Whether an arrival is late, in one place.
 *
 * **The rule is judged to the minute, not the second.** An arrival at 09:30:10
 * against a 09:30 cutoff is on time; lateness begins at 09:31:00. A person
 * reading a clock on the wall sees "09:30" for the whole of that minute, and a
 * rule nobody can comply with by looking at a clock is not a rule anyone can
 * follow. Seconds also come from a device whose clock drifts, so charging
 * someone for ten of them is measuring the hardware, not the person.
 *
 * Everything that judges an arrival calls this - the per-employee attendance
 * read, the workforce summary, the performance reports - so the same punch can
 * never be late on one screen and on time on another.
 */

/** "HH:MM" (or "HH:MM:SS") to minutes past midnight, seconds discarded. */
function cutoffToMinutes(cutoffTime) {
  const [hour, minute] = String(cutoffTime || "")
    .split(":")
    .map(Number);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  return hour * 60 + minute;
}

/** Minutes past midnight for an instant, in the office timezone. */
function arrivalMinutes(timestamp) {
  const { hour, minute } = zonedParts(new Date(timestamp));
  return Number(hour) * 60 + Number(minute);
}

/** "1h 5m", "12m", or null when not late. */
function formatLateness(lateMinutes) {
  if (!lateMinutes || lateMinutes < 1) return null;
  if (lateMinutes < 60) return `${lateMinutes}m`;
  const hours = Math.floor(lateMinutes / 60);
  const minutes = lateMinutes % 60;
  return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
}

/**
 * Judges one arrival.
 *
 * @param {Date|string|number} timestamp  When they punched in
 * @param {string} cutoffTime             The office arrival time, "HH:MM"
 * @returns {{ isLate: boolean, lateMinutes: number, lateDisplay: string|null }}
 */
function judgeArrival(timestamp, cutoffTime) {
  const cutoff = cutoffToMinutes(cutoffTime);
  const arrived = arrivalMinutes(timestamp);

  if (cutoff == null || !Number.isFinite(arrived)) {
    return { isLate: false, lateMinutes: 0, lateDisplay: null };
  }

  // Strictly greater: the cutoff minute itself is on time, so a 09:30 rule is
  // met by anyone through 09:30:59.
  if (arrived <= cutoff) {
    return { isLate: false, lateMinutes: 0, lateDisplay: null };
  }

  const lateMinutes = arrived - cutoff;
  return {
    isLate: true,
    lateMinutes,
    lateDisplay: formatLateness(lateMinutes),
  };
}

/** The boolean alone, for callers that only count. */
const isLateArrival = (timestamp, cutoffTime) =>
  judgeArrival(timestamp, cutoffTime).isLate;

module.exports = {
  judgeArrival,
  isLateArrival,
  cutoffToMinutes,
  arrivalMinutes,
  formatLateness,
};
