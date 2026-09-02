/**
 * timezone.js
 * -----------
 * The single place that decides what "a day" and "a time of day" mean.
 *
 * A ZKTeco device records local wall-clock time. The agent converts each punch
 * into an absolute instant and that instant is what the database stores, which
 * is correct and unambiguous. Everything a person reads, though - the time on a
 * row, the day a punch belongs to, the range behind a date picker - has to be
 * expressed in the office's own timezone.
 *
 * Deriving those from toISOString() expresses them in UTC instead. In Pakistan
 * (UTC+5) that shows an 08:42 arrival as 03:42, and files any punch made before
 * 05:00 local under the previous day. The server's own timezone is not a
 * substitute either: it is UTC on Railway and PKT on a developer laptop, so the
 * same record would read differently in each place.
 *
 * Set APP_TIMEZONE to any IANA zone name to move the office.
 */

const APP_TIMEZONE = process.env.APP_TIMEZONE || "Asia/Karachi";

/** Reused across every record; constructing a formatter per call is expensive. */
const partsFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: APP_TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

/** Wall-clock fields for an instant, as seen in the office timezone. */
function zonedParts(date) {
  const parts = {};
  for (const { type, value } of partsFormatter.formatToParts(date)) {
    if (type !== "literal") parts[type] = value;
  }
  // Some engines render midnight as hour 24; normalise it to 00.
  if (parts.hour === "24") parts.hour = "00";
  return parts;
}

/** Calendar day the punch belongs to, in the office timezone. YYYY-MM-DD. */
function localDateString(date) {
  const { year, month, day } = zonedParts(date);
  return `${year}-${month}-${day}`;
}

/** Wall-clock time of the punch, in the office timezone. HH:MM:SS. */
function localTimeString(date) {
  const { hour, minute, second } = zonedParts(date);
  return `${hour}:${minute}:${second}`;
}

/**
 * The zone's UTC offset in milliseconds at a given instant.
 *
 * Derived by formatting the instant in the zone and comparing it with the same
 * wall-clock reading interpreted as UTC. This handles daylight saving without a
 * table: the offset is looked up for that specific instant.
 */
function offsetMsAt(date) {
  const { year, month, day, hour, minute, second } = zonedParts(date);
  const asUtc = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second)
  );
  // Second precision is enough; the stored timestamps carry no sub-second part.
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/**
 * Convert a local wall-clock reading into the instant it denotes.
 *
 * The offset is resolved iteratively because the correct offset depends on the
 * instant, which is what is being computed. One correction settles it for every
 * real zone; a second guards the hour either side of a DST transition.
 */
function zonedTimeToInstant(year, month, day, hour, minute, second, ms = 0) {
  let guess = Date.UTC(year, month - 1, day, hour, minute, second, ms);
  for (let i = 0; i < 2; i += 1) {
    const offset = offsetMsAt(new Date(guess));
    const corrected =
      Date.UTC(year, month - 1, day, hour, minute, second, ms) - offset;
    if (corrected === guess) break;
    guess = corrected;
  }
  return new Date(guess);
}

/**
 * The instants spanned by a range of local calendar days, inclusive.
 *
 * A user picking 2 September means their own 2 September, midnight to midnight
 * in the office - not the UTC day of the same name.
 *
 * @param {string} startDate YYYY-MM-DD
 * @param {string} endDate   YYYY-MM-DD
 */
function localDayRange(startDate, endDate) {
  const [sy, sm, sd] = String(startDate).split("-").map(Number);
  const [ey, em, ed] = String(endDate).split("-").map(Number);

  return {
    start: zonedTimeToInstant(sy, sm, sd, 0, 0, 0, 0),
    end: zonedTimeToInstant(ey, em, ed, 23, 59, 59, 999),
  };
}

/** Today's calendar date in the office timezone. YYYY-MM-DD. */
function today() {
  return localDateString(new Date());
}

module.exports = {
  APP_TIMEZONE,
  zonedParts,
  localDateString,
  localTimeString,
  localDayRange,
  zonedTimeToInstant,
  offsetMsAt,
  today,
};
