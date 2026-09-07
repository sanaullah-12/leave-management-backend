/**
 * lateHours.js
 * ------------
 * Late minutes into hours, and a set of late days into one running total.
 *
 * Nothing here is stored. Every figure is derived from the attendance records
 * on each read, so a total can never drift from the punches behind it and
 * there is no accumulator for anyone to edit by hand. Removing a punch or
 * moving the arrival rule changes the total on the next read, which is the
 * only behaviour that keeps the number honest.
 *
 * utils/lateness.js decides whether one arrival is late. This file only adds
 * up what that decided, so the two can never disagree about a day.
 */

const MINUTES_PER_HOUR = 60;

/**
 * A total in minutes as hours and minutes.
 *
 * 60 -> 1h 0m, 90 -> 1h 30m, 125 -> 2h 5m.
 */
function splitDuration(totalMinutes) {
  const safe = Math.max(0, Math.round(Number(totalMinutes) || 0));
  return {
    hours: Math.floor(safe / MINUTES_PER_HOUR),
    minutes: safe % MINUTES_PER_HOUR,
    totalMinutes: safe,
  };
}

/**
 * A total in minutes, written the way a person says it.
 *
 * Unlike formatLateness() in lateness.js, which returns null for "not late",
 * this always renders a value: a total of zero is a real reading on a summary
 * card and has to print as "0m" rather than disappear.
 */
function formatDuration(totalMinutes) {
  const { hours, minutes } = splitDuration(totalMinutes);
  if (!hours) return `${minutes}m`;
  return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
}

/**
 * Hours as a decimal, for reports that chart or export rather than read.
 * 125 minutes -> 2.08.
 */
function decimalHours(totalMinutes) {
  const { totalMinutes: safe } = splitDuration(totalMinutes);
  return Math.round((safe / MINUTES_PER_HOUR) * 100) / 100;
}

/**
 * Add up the days.
 *
 * @param {Array<{date: string, lateMinutes: number, isLate: boolean}>} entries
 *   One entry per judged day, late or not. Days that were never judged - a
 *   weekend, a day with no punch - are not passed in at all, so they can never
 *   be counted as either.
 * @param {{daysConsidered?: number}} context
 */
function summariseEntries(entries = [], context = {}) {
  const lateEntries = entries.filter((entry) => entry.lateMinutes > 0);

  const totalLateMinutes = lateEntries.reduce(
    (sum, entry) => sum + entry.lateMinutes,
    0
  );

  const split = splitDuration(totalLateMinutes);

  // Averaged over the days someone was actually late, not over the range: a
  // month with one bad morning should not read as "on average 20 seconds
  // late", which describes nobody's behaviour.
  const averageLateMinutes = lateEntries.length
    ? Math.round(totalLateMinutes / lateEntries.length)
    : 0;

  const worst = lateEntries.reduce(
    (worstSoFar, entry) =>
      !worstSoFar || entry.lateMinutes > worstSoFar.lateMinutes
        ? entry
        : worstSoFar,
    null
  );

  return {
    totalLateMinutes,
    lateHours: split.hours,
    remainderMinutes: split.minutes,
    decimalHours: decimalHours(totalLateMinutes),
    /** "2h 5m". The reading for a card. */
    totalLateDisplay: formatDuration(totalLateMinutes),
    lateDays: lateEntries.length,
    averageLateMinutes,
    averageLateDisplay: formatDuration(averageLateMinutes),
    worstDay: worst
      ? {
          date: worst.date,
          dateDisplay: worst.dateDisplay,
          lateMinutes: worst.lateMinutes,
          lateDisplay: worst.lateDisplay,
        }
      : null,
    /** Days with a punch that the rule was applied to. */
    daysConsidered: context.daysConsidered ?? entries.length,
    /** Judged days that were on time. */
    onTimeDays: Math.max(0, entries.length - lateEntries.length),
  };
}

/** The shape summariseEntries returns for an employee with nothing recorded. */
function emptySummary() {
  return summariseEntries([], { daysConsidered: 0 });
}

module.exports = {
  splitDuration,
  formatDuration,
  decimalHours,
  summariseEntries,
  emptySummary,
};
