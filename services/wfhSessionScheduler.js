const WfhWorkSession = require("../models/WfhWorkSession");
const wfhSessionService = require("./wfhSessionService");
const wfhSessionNotifier = require("./wfhSessionNotifier");
const { today } = require("../utils/timezone");

/**
 * wfhSessionScheduler
 * -------------------
 * Notices that someone has stopped working, so the admin hears about it without
 * anyone having to open a page.
 *
 * It is NOT what makes the numbers right. `wfhSessionService.reconcile()` does
 * that, and it runs on every read, so a server that was down all night still
 * reports a correct day the first time anyone asks. This exists purely for
 * timeliness: the difference between "Ali went idle at 11:35" reaching an admin
 * at 11:36 and reaching them whenever somebody next happens to look.
 *
 * That distinction is what makes it safe. A tick that is missed, fires twice,
 * or runs on two instances at once costs nothing - reconciliation is idempotent,
 * and the notifications it produces are deduplicated by a unique key rather than
 * by this loop being the only one running.
 *
 * Polling rather than a cron expression, matching unreportedAbsenceScheduler
 * and attendanceSync: no dependency, and the work is cheap because the query is
 * indexed on exactly the sessions that could have changed.
 */

/**
 * A minute. The idle threshold is five, so the worst case is a notification
 * that is one minute late - well inside what "immediately" means to a person
 * watching a monitor, and sixty times less work than polling every second.
 *
 * While the idle rule is off the sweep still runs, for the two things that have
 * nothing to do with inactivity: a day left open overnight and the hard cap.
 */
const TICK_MS = 60 * 1000;

class WfhSessionScheduler {
  constructor() {
    this.timer = null;
    this.running = false;
  }

  start() {
    if (this.timer) return;

    console.log(
      `Work from home timers: sweeping every ${TICK_MS / 1000}s (${
        wfhSessionService.CONFIG.inactivityAutoPause
          ? `idle after ${wfhSessionService.CONFIG.idleTimeoutMinutes}m`
          : "inactivity auto-pause off"
      })`
    );
    // A first pass on boot closes out anything left open while the server was
    // down, rather than waiting a minute to notice a day that ended last night.
    this.tick();
    this.timer = setInterval(() => this.tick(), TICK_MS);
    // Never hold the process open on its own account.
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    console.log("Work from home timers: stopped");
  }

  async tick() {
    // A tick that overran must not have a second one starting underneath it.
    // Nothing is lost: whatever it does not reach is still open next minute.
    if (this.running) return;
    this.running = true;

    try {
      // Only sessions that are still open can change, and a session whose last
      // sign of life is recent cannot have gone idle yet. The index on
      // { status, lastActivityAt } serves this directly, so the query cost does
      // not grow with the history.
      const cutoff = new Date(
        Date.now() - wfhSessionService.CONFIG.idleTimeoutMinutes * 60 * 1000
      );

      const hardCap = new Date(
        Date.now() - wfhSessionService.CONFIG.maxSessionHours * 60 * 60 * 1000
      );

      // Someone stopped being there - a candidate only while the idle rule is
      // on. With it off those sessions are still running, so asking about them
      // every minute would walk the company to be told nothing each time.
      const wentQuiet = wfhSessionService.CONFIG.inactivityAutoPause
        ? [{ status: "working", lastActivityAt: { $lte: cutoff } }]
        : [];

      // Exactly the things that can change without anyone clicking. Each is
      // narrow on purpose: a sweep that pulled every open session would walk
      // the whole company every minute to find that nothing had happened.
      const candidates = await WfhWorkSession.find({
        $or: [
          ...wentQuiet,
          // A day that ended without anyone pressing Finish. Reconciliation
          // completes these, so each one appears in this set exactly once.
          { status: "paused", date: { $lt: today() } },
          // A timer that has been running implausibly long - the backstop for
          // the one thing activity signals cannot rule out.
          { status: "working", startedAt: { $lte: hardCap } },
        ],
      })
        .populate("employee", "name")
        .limit(500);

      const now = new Date();
      for (const doc of candidates) {
        try {
          const { session, transitions } = await wfhSessionService.reconcile(
            doc,
            now
          );
          if (!transitions.length) continue;

          await wfhSessionNotifier.announce({
            session: wfhSessionService.serialize(session, now),
            transitions,
            employee: session.employee,
            companyId: session.company,
          });
        } catch (error) {
          // One bad session must not stop the rest of the company's day from
          // being reconciled.
          console.error(
            `Work from home timer sweep failed for session ${doc._id}:`,
            error.message
          );
        }
      }
    } catch (error) {
      // A failed sweep must never take the server with it; the next tick finds
      // exactly the same sessions still open and retries them.
      console.error("Work from home timer sweep failed:", error.message);
    } finally {
      this.running = false;
    }
  }
}

module.exports = new WfhSessionScheduler();
