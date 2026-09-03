const unreportedAbsenceService = require("./unreportedAbsenceService");
const { localDateString } = require("../utils/timezone");

/**
 * unreportedAbsenceScheduler
 * --------------------------
 * Runs the unreported-absence rule once a day, shortly after the cutoff.
 *
 * A polling tick rather than a cron expression: the codebase already schedules
 * this way (`services/attendanceSync.js`), it needs no dependency, and the rule
 * is idempotent - a day already processed is skipped inside the service - so a
 * tick that fires twice, or a process that restarts mid-afternoon, costs
 * nothing and cannot double-charge anyone.
 *
 * The in-memory `lastRunDate` only avoids pointless database reads. Correctness
 * comes from the service, not from this guard, which is why a restart is safe.
 */

const TICK_MS = 10 * 60 * 1000; // ten minutes; the cutoff is not to the second

class UnreportedAbsenceScheduler {
  constructor() {
    this.timer = null;
    this.lastRunDate = null;
    this.running = false;
  }

  start() {
    if (this.timer) return;

    console.log("Unreported absence rule: scheduled (checks every 10 minutes)");
    // A first pass on boot catches a server that was down at the cutoff.
    this.tick();
    this.timer = setInterval(() => this.tick(), TICK_MS);
    // Never hold the process open on its own account.
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    console.log("Unreported absence rule: stopped");
  }

  async tick() {
    if (this.running) return;

    const day = localDateString(new Date());
    if (this.lastRunDate === day) return;

    try {
      const policy = await unreportedAbsenceService.getPolicy();
      if (!policy.enabled) return;
      if (!unreportedAbsenceService.cutoffHasPassed(day, policy.cutoffTime)) {
        return;
      }

      this.running = true;
      const reports = await unreportedAbsenceService.runForAllCompanies({
        date: day,
      });
      this.lastRunDate = day;

      const marked = reports.reduce((sum, r) => sum + r.marked.length, 0);
      if (marked) {
        console.log(
          `Unreported absence rule: ${marked} day(s) recorded as leave for ${day}`
        );
      }
    } catch (error) {
      // A failed run must never take the server with it; the next tick retries
      // because lastRunDate was not advanced.
      console.error("Unreported absence run failed:", error.message);
    } finally {
      this.running = false;
    }
  }
}

module.exports = new UnreportedAbsenceScheduler();
