const { today } = require("../utils/timezone");

/**
 * wfhPolicyService
 * ----------------
 * The rules a work-from-home request is judged against, in one place.
 *
 * V1 has exactly one rule - how far back a request may reach - but it lives
 * here rather than inline in the route because every policy feature named for
 * V2 (monthly limits, a notice period, eligibility by department, approval
 * chains) is a field on this object and a check beside `validateDates`.
 *
 * Resolution order is company override, then environment, then the default.
 * Only the last two exist today; `getPolicy` already takes the company id so
 * adding a `company.wfhPolicy` block later changes nothing at the call sites.
 */

const DEFAULTS = Object.freeze({
  /**
   * How many days back a request may start.
   *
   * People forget. Someone who worked from home on Monday and remembers on
   * Wednesday needs a way to put the record straight, and refusing them leaves
   * two days permanently marked absent - a false record, which is worse than a
   * late request. The window is short so it stays a correction rather than a
   * way to rewrite last quarter.
   *
   * 0 disables backdating entirely.
   */
  backdatingWindowDays: 7,
});

/** YYYY-MM-DD, n days before today in the office timezone. */
const daysBefore = (n) => {
  const [y, m, d] = today().split("-").map(Number);
  const cursor = new Date(Date.UTC(y, m - 1, d));
  cursor.setUTCDate(cursor.getUTCDate() - n);
  const pad = (v) => String(v).padStart(2, "0");
  return `${cursor.getUTCFullYear()}-${pad(cursor.getUTCMonth() + 1)}-${pad(
    cursor.getUTCDate()
  )}`;
};

/**
 * The effective policy for a company.
 *
 * Async and company-scoped from the start, so the day a company-level override
 * lands no caller has to change.
 */
// eslint-disable-next-line no-unused-vars
async function getPolicy(companyId) {
  const configured = Number(process.env.WFH_BACKDATE_DAYS);
  const backdatingWindowDays = Number.isFinite(configured)
    ? Math.max(0, configured)
    : DEFAULTS.backdatingWindowDays;

  return {
    backdatingWindowDays,
    /** The earliest start date a request may carry, as YYYY-MM-DD. */
    earliestStartDate: daysBefore(backdatingWindowDays),
    today: today(),
  };
}

/**
 * Checks a requested range against the policy.
 *
 * @returns {{ ok: true, isBackdated: boolean } | { ok: false, message: string }}
 */
function validateDates({ startDate, endDate, policy }) {
  if (endDate < startDate) {
    return { ok: false, message: "End date must be on or after the start date" };
  }

  if (startDate < policy.earliestStartDate) {
    return {
      ok: false,
      message: policy.backdatingWindowDays
        ? `A work from home request can reach back at most ${
            policy.backdatingWindowDays
          } day(s), so the earliest date you can request is ${
            policy.earliestStartDate
          }. Ask an administrator to record anything older.`
        : "Start date cannot be in the past",
    };
  }

  return { ok: true, isBackdated: startDate < policy.today };
}

/**
 * Checks the hours an employee says they intend to keep.
 *
 * Deliberately permissive: the plan is context for a reviewer, not a
 * constraint the day is judged against, so anything that reads as a real
 * working window is accepted. Only two things are rejected - a time that is
 * not a time, and a window that ends before it starts - because both would
 * render as nonsense on the card and in the summary.
 *
 * Giving no plan at all is fine. Requests raised before planned times existed
 * have none, and a day can still be timed without one.
 *
 * @returns {{ ok: true, plannedStartTime: string, plannedEndTime: string }
 *          | { ok: false, message: string }}
 */
function validatePlannedTimes({ plannedStartTime, plannedEndTime }) {
  const start = String(plannedStartTime || "").trim();
  const end = String(plannedEndTime || "").trim();

  if (!start && !end) return { ok: true, plannedStartTime: "", plannedEndTime: "" };

  const shape = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (!shape.test(start) || !shape.test(end)) {
    return {
      ok: false,
      message: "Give both a planned start and a planned end time, as HH:MM.",
    };
  }

  // Equal is rejected along with inverted: a window of zero length is not a
  // plan, and it would render as "10:00 AM - 10:00 AM" on every screen.
  if (end <= start) {
    return {
      ok: false,
      message: "The planned end time must be later than the planned start time.",
    };
  }

  return { ok: true, plannedStartTime: start, plannedEndTime: end };
}

module.exports = { DEFAULTS, getPolicy, validateDates, validatePlannedTimes };
