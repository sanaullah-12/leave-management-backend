const User = require("../models/User");
const SocketService = require("../socket/socketService");
const { notifyWfhSessionEvent } = require("../utils/notifications");
const { NOTIFICATION_EVENTS } = require("../notifications");
const wfhSessionService = require("./wfhSessionService");

/**
 * wfhSessionNotifier
 * ------------------
 * Turns a change in someone's work-from-home day into the two things the rest
 * of the system expects: a real-time nudge, and a notification.
 *
 * It exists because three callers cause the same changes - the employee's own
 * actions in routes/wfhSessions.js, the sweeper in wfhSessionScheduler.js, and
 * the reconciliation any read can trigger - and an idle employee must be
 * announced identically whichever of them noticed. Putting it here is what
 * stops "the admin was told" from depending on which code path ran.
 *
 * Nothing in here can fail a caller. A session that was saved is saved; an
 * announcement that could not be made is logged and dropped, exactly as the
 * leave and WFH request routes already treat theirs.
 */

/** Which session transition announces which event. */
const EVENT_FOR = {
  started: NOTIFICATION_EVENTS.WFH_SESSION_STARTED,
  paused: NOTIFICATION_EVENTS.WFH_SESSION_IDLE,
  auto_paused: NOTIFICATION_EVENTS.WFH_SESSION_IDLE,
  resumed: NOTIFICATION_EVENTS.WFH_SESSION_RESUMED,
  finished: NOTIFICATION_EVENTS.WFH_SESSION_FINISHED,
  auto_finished: NOTIFICATION_EVENTS.WFH_SESSION_FINISHED,
};

/**
 * The extra fields each event's copy needs beyond the common payload.
 *
 * Every one of them is read off the serialized session rather than passed in,
 * so a notification can never quote a number the session does not actually
 * hold.
 */
const extrasFor = (transition, session) => {
  switch (transition) {
    case "paused":
    case "auto_paused":
      return {
        pausedAt: session.lastWorkedAt || session.lastActivityAt,
        idleTimeoutMinutes: wfhSessionService.CONFIG.idleTimeoutMinutes,
        automatic: transition === "auto_paused",
      };
    case "resumed":
      return { resumedAt: session.lastActivityAt };
    case "finished":
    case "auto_finished":
      return {
        endedAt: session.lastWorkedAt || session.finishedAt,
        closedBySystem: transition === "auto_finished",
      };
    default:
      return {};
  }
};

/**
 * A session's employee id, whether the document arrived populated or not.
 *
 * The monitor populates its sessions and the employee's own routes do not, so
 * both shapes reach here. Stringifying the populated one without unwrapping it
 * would put "[object Object]" in a socket room name and quietly deliver
 * nothing.
 */
const employeeIdOf = (session) => {
  const value = session.employee;
  return String((value && value._id) || value);
};

/** The employee's name, looked up only when the caller does not already have it. */
const resolveEmployee = async (session, provided) => {
  const id = employeeIdOf(session);
  if (provided && provided.name) {
    return { _id: provided._id || id, name: provided.name };
  }
  if (session.employee && session.employee.name) {
    return { _id: id, name: session.employee.name };
  }
  const user = await User.findById(id).select("name").lean();
  return { _id: id, name: (user && user.name) || "An employee" };
};

/**
 * Announces one or more transitions on a session.
 *
 * @param {object} options
 * @param {object} options.session   A serialized session (wfhSessionService.serialize)
 * @param {string[]} options.transitions  "started" | "paused" | "auto_paused" | ...
 * @param {object=} options.employee { _id, name } when the caller already has it
 * @param {string} options.companyId
 */
async function announce({ session, transitions = [], employee, companyId }) {
  if (!session || !transitions.length) return;

  try {
    const person = await resolveEmployee(session, employee);
    const bucket = wfhSessionService.throttleBucket();

    // The live signal first. It is cheap, it is what the open monitor is
    // waiting on, and it must not queue behind a notification channel that may
    // be talking to a third party.
    emitSessionUpdate({
      session,
      companyId,
      employeeName: person.name,
      transitions,
    });

    for (const transition of transitions) {
      const event = EVENT_FOR[transition];
      if (!event) continue;
      await notifyWfhSessionEvent({
        event,
        session,
        employee: person,
        companyId,
        bucket,
        extra: extrasFor(transition, session),
      });
    }
  } catch (error) {
    // The session itself is already saved. Losing the announcement is a
    // degraded outcome, never a failed one.
    console.error(
      `WFH session announcement failed for ${session._id}:`,
      error.message
    );
  }
}

/**
 * The real-time signal.
 *
 * Sent to the company's admins - who are watching the monitor - and to the
 * employee's own devices, so a second tab and a phone can never show two
 * different timers for the same day. The payload is a summary rather than the
 * whole session: clients refetch on it, which is the pattern every other
 * module here already follows and the only one that survives an event being
 * missed while offline.
 *
 * It carries the few figures a desktop notification has to quote - when the day
 * began, how much is counted, and the idle rule that stopped it - so the copy
 * on the client is written from the server's numbers rather than from whatever
 * happens to be in a cache when the event lands.
 */
function emitSessionUpdate({ session, companyId, employeeName, transitions = [] }) {
  const employeeId = employeeIdOf(session);
  const payload = {
    sessionId: String(session._id),
    employeeId,
    employeeName,
    date: session.date,
    status: session.status,
    activeMs: session.activeMs,
    startedAt: session.startedAt,
    idleTimeoutMinutes: wfhSessionService.CONFIG.idleTimeoutMinutes,
    transitions,
  };

  SocketService.toCompanyAdmins(
    companyId,
    SocketService.events.WFH_SESSION,
    payload
  );
  SocketService.toUser(
    employeeId,
    SocketService.events.WFH_SESSION,
    payload
  );
}

module.exports = { announce, emitSessionUpdate, EVENT_FOR };
