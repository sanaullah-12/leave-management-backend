const WfhWorkSession = require("../models/WfhWorkSession");
const WorkFromHome = require("../models/WorkFromHome");
const { today, localDateString } = require("../utils/timezone");

/**
 * wfhSessionService
 * -----------------
 * Everything that decides how long someone actually worked from home.
 *
 * The routes in routes/wfhSessions.js do authentication, shape checking and
 * responses; every rule about time lives here, so the sweeper, the employee's
 * card and the admin monitor can never disagree about a number.
 *
 * Three ideas hold the whole thing together.
 *
 * 1. The server stamps every instant.
 *    Nothing a browser sends reaches a date field. A tampered clock, a forged
 *    request body and a replayed one all produce the same result as an honest
 *    click, because the only clock consulted is this process's.
 *
 * 2. `lastActivityAt` is what makes inactivity honest - when the rule is on.
 *    It is currently off (CONFIG.inactivityAutoPause), so a timer stops when
 *    the employee stops it and at no other time. What follows describes the
 *    rule as it behaves once it is switched back on.
 *    When a stretch of work is closed for inactivity it is cut back to the last
 *    moment the server saw a sign of life, not to the moment the server
 *    noticed. The idle minutes are therefore never counted - and a closed
 *    laptop, a killed tab, a crashed browser and a dropped connection all
 *    behave identically, because all four simply stop updating it. There is no
 *    "disconnect" case to handle separately; there is only a value that stopped
 *    moving.
 *
 * 3. Reads reconcile.
 *    `reconcile()` runs on every path that looks at a session, not only in the
 *    sweeper. A server that was down all night still returns correct numbers the
 *    first time anyone asks, because the correction is computed from the stored
 *    timestamps rather than from having been running at the right moment. The
 *    sweeper exists only so the ADMIN hears about an idle employee without
 *    someone happening to open a page.
 *
 * What this deliberately does not do: watch what the employee is doing. The
 * browser reports that input happened, never what it was. See
 * routes/wfhSessions.js for the shape of a heartbeat - it carries no content.
 */

// ------------------------------------------------------------------ Config

const minutesEnv = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

const CONFIG = {
  /**
   * How long without a sign of life before the timer stops counting.
   *
   * Five minutes is the brief given. Long enough to read a document or take a
   * call without being told off, short enough that an empty chair is noticed.
   */
  get idleTimeoutMinutes() {
    return minutesEnv("WFH_IDLE_TIMEOUT_MINUTES", 5);
  },
  /**
   * Whether that silence stops the timer.
   *
   * Currently off: the day runs from Start until the employee pauses or
   * finishes it, and nothing about the mouse or the keyboard is consulted on
   * either side. Set WFH_INACTIVITY_AUTOPAUSE=true to put the rule back - none
   * of it has been removed, and the handful of reads of this flag are the only
   * places it is asked about.
   */
  get inactivityAutoPause() {
    return (
      String(process.env.WFH_INACTIVITY_AUTOPAUSE || "")
        .trim()
        .toLowerCase() === "true"
    );
  },
  /**
   * How often the browser says "still here" while the timer runs.
   *
   * It bounds how much work can be lost when a tab dies: at worst the last
   * interval, because the segment is cut back to the last heartbeat. Shorter is
   * more accurate and more requests; this is the balance point for a page that
   * may be open all day.
   */
  get heartbeatSeconds() {
    const value = Number(process.env.WFH_HEARTBEAT_SECONDS);
    return Number.isFinite(value) && value >= 15 ? value : 60;
  },
  /**
   * A day cannot run longer than this, whatever the heartbeats claim.
   *
   * The backstop for the one thing browser signals cannot rule out - a tab left
   * running somewhere with something jiggling the mouse. Sixteen hours is well
   * past any real working day, so it never truncates honest work, and it caps
   * what a runaway session can ever report.
   */
  get maxSessionHours() {
    const value = Number(process.env.WFH_MAX_SESSION_HOURS);
    return Number.isFinite(value) && value > 0 ? value : 16;
  },
  /**
   * Minutes between repeat admin notifications about the same kind of event on
   * the same session.
   *
   * Someone who steps away four times in an hour is one situation, not four
   * notifications. Start and Finish happen once per day and are never
   * throttled; only the pair that can flap is.
   */
  get notifyThrottleMinutes() {
    return minutesEnv("WFH_NOTIFY_THROTTLE_MINUTES", 15);
  },
};

const idleMs = () => CONFIG.idleTimeoutMinutes * 60 * 1000;
/** Whether a stretch of silence is allowed to stop the clock. */
const autoPauses = () => CONFIG.inactivityAutoPause;
const maxSessionMs = () => CONFIG.maxSessionHours * 60 * 60 * 1000;

/** The settings a client needs to behave correctly, in one object. */
function getConfig() {
  return {
    idleTimeoutMinutes: CONFIG.idleTimeoutMinutes,
    idleTimeoutMs: idleMs(),
    /**
     * False while the idle rule is off. The browser reads this to decide
     * whether to watch input at all, so the page and the server can never be
     * doing different things - one switch, both halves.
     */
    inactivityAutoPause: CONFIG.inactivityAutoPause,
    heartbeatSeconds: CONFIG.heartbeatSeconds,
    maxSessionHours: CONFIG.maxSessionHours,
  };
}

// ------------------------------------------------------------------ Errors

/**
 * A rule said no, and the employee should be told which one.
 *
 * Carries the HTTP status so routes translate rather than re-derive it, and a
 * `code` so the client can react to a specific case (an already-running session
 * is worth re-rendering the card for; a missing approval is not).
 */
class SessionRuleError extends Error {
  constructor(message, { status = 400, code = "rule_violation" } = {}) {
    super(message);
    this.name = "SessionRuleError";
    this.status = status;
    this.code = code;
  }
}

// ------------------------------------------------------------- Time totals

const ms = (date) => new Date(date).getTime();

/**
 * The instant a running stretch is counted up to.
 *
 * With the idle rule on it is the last sign of life, never now: counting to now
 * would mean every total quietly included however long the person had already
 * been away, and would then jump BACKWARDS by up to the idle timeout the moment
 * the server noticed - a worked-time figure that decreases is worse than one
 * that lags.
 *
 * With the rule off nothing is ever cut back, so there is no jump to avoid and
 * the honest end of a running stretch is now. Stopping it at the last heartbeat
 * would freeze a timer that is still running.
 */
const countedUpTo = (session, now = new Date()) =>
  autoPauses() ? ms(session.lastActivityAt) : ms(now);

/** The one segment still running, if any. The invariant is: at most one. */
const openSegment = (session) =>
  (session.segments || []).find((segment) => !segment.endedAt) || null;

/**
 * Milliseconds actually worked, and the instant that total is current as of.
 *
 * A running segment is counted up to `countedUpTo` - now while the idle rule
 * is off, the last sign of life while it is on.
 *
 * The employee's own card ticks forward from `countingSince`; that is display
 * only, and the next read replaces it with this number.
 */
function totalsFor(session, now = new Date()) {
  const segments = session.segments || [];
  let activeMs = 0;

  for (const segment of segments) {
    if (!segment.endedAt) continue;
    activeMs += Math.max(0, ms(segment.endedAt) - ms(segment.startedAt));
  }

  const open = openSegment(session);
  if (open) {
    // Never below the segment's own start: a session resumed and then read in
    // the same millisecond must contribute zero, not a negative.
    const countedTo = Math.max(ms(open.startedAt), countedUpTo(session, now));
    activeMs += countedTo - ms(open.startedAt);
  }

  // The end of the span the day is measured over. While working, the day is
  // only known up to the last sign of life; while paused, the gap is growing
  // right now; once finished, the day is closed.
  const asOf =
    session.status === "completed"
      ? ms(session.finishedAt || session.lastActivityAt)
      : session.status === "paused"
      ? ms(now)
      : Math.max(countedUpTo(session, now), ms(session.startedAt));

  const spanMs = Math.max(0, asOf - ms(session.startedAt));

  return {
    activeMs,
    /**
     * Everything inside the day that was not worked. Derived, never stored:
     * a stored idle total could drift out of step with the segments, and then
     * two numbers on the same card would contradict each other.
     */
    idleMs: Math.max(0, spanMs - activeMs),
    spanMs,
    segmentCount: segments.length,
    asOf: new Date(asOf),
  };
}

/** When work actually stopped, which is not when Finish was pressed. */
const lastWorkedAt = (session) => {
  const segments = session.segments || [];
  const open = openSegment(session);
  if (open) return session.lastActivityAt;
  const last = segments[segments.length - 1];
  return last ? last.endedAt : null;
};

// ------------------------------------------------------------------ Tasks

/** The one task being worked on, if any. The invariant is: at most one. */
const activeTask = (session) =>
  (session.tasks || []).find((task) => task.status === "active") || null;

/** Closes a task's open span. Clamped to its own start, as segments are. */
const closeTaskSpan = (task, at) => {
  const open = (task.spans || []).find((span) => !span.to);
  if (!open) return;
  open.to = new Date(Math.max(ms(open.from), ms(at)));
};

/** Closes every open span on the day. Used when the day itself closes. */
const closeTaskSpans = (session, at) => {
  for (const task of session.tasks || []) closeTaskSpan(task, at);
};

/**
 * What each task took, and when, keyed by task id.
 *
 * The overlap of two independent things: the stretches the employee was
 * working (`segments`) and the stretches each task was the one in hand
 * (`spans`). Neither is derived from the other, which is what makes the
 * arithmetic honest in both directions - a task cannot accrue time across a
 * pause, because the segment is closed and an overlap with nothing is nothing;
 * and switching tasks cannot change the day's total, because it never touches a
 * segment.
 *
 * A running segment is counted to the same instant `totalsFor` counts it to,
 * so the parts can never add up to more than the whole.
 *
 * Each span is reported alongside its own worked total, because the admin's
 * report needs both: "9:00 AM to 12:00 PM" says when somebody was on a task,
 * and the 2h 45m beside it says how much of those three hours was actually
 * counted. Printing only the first would quietly turn a lunch break into work.
 */
function taskBreakdown(session, now = new Date()) {
  const worked = (session.segments || []).map((segment) => {
    const from = ms(segment.startedAt);
    return {
      from,
      to: segment.endedAt
        ? ms(segment.endedAt)
        : Math.max(from, countedUpTo(session, now)),
    };
  });

  const byTask = new Map();

  for (const task of session.tasks || []) {
    let total = 0;
    const spans = [];

    for (const span of task.spans || []) {
      const spanFrom = ms(span.from);
      // An open span has no end of its own; the segment it is measured against
      // supplies one, and that segment is already bounded by the last sign of
      // life. There is nothing for an unbounded span to run away with.
      const spanTo = span.to ? ms(span.to) : Infinity;

      let spanMs = 0;
      for (const segment of worked) {
        const from = Math.max(spanFrom, segment.from);
        const to = Math.min(spanTo, segment.to);
        if (to > from) spanMs += to - from;
      }

      total += spanMs;
      spans.push({
        from: span.from,
        /** Null while this is the task in hand - the report reads it as "now". */
        to: span.to || null,
        activeMs: spanMs,
      });
    }

    byTask.set(String(task._id), { activeMs: total, spans });
  }

  return byTask;
}

/** Milliseconds worked on each task, keyed by task id. */
function taskTotals(session, now = new Date()) {
  const totals = new Map();
  for (const [id, entry] of taskBreakdown(session, now)) {
    totals.set(id, entry.activeMs);
  }
  return totals;
}

/**
 * A day cannot carry an unbounded number of tasks.
 *
 * The list is a working record of one day, not a backlog. The cap keeps the
 * document a sensible size and the panel readable; nobody legitimately switches
 * between fifty tasks between one morning and one evening.
 */
const MAX_TASKS = 50;

/** The tasks stated on the request, cleaned up and capped. */
const plannedTasksOf = (request) =>
  ((request && request.plannedTasks) || [])
    .map((title) => String(title || "").trim())
    .filter(Boolean)
    .slice(0, MAX_TASKS);

// ------------------------------------------------------------- Transitions

/** Appends to the audit trail. Nothing in this file ever edits an entry. */
const record = (session, type, at, { actor = "employee", note = "" } = {}) => {
  session.events.push({ type, at, actor, note });
};

/**
 * Closes the running segment at a given instant.
 *
 * Clamped to the segment's own start so a cut-back can never invert it, which
 * would turn into negative worked time.
 */
const closeOpenSegment = (session, at, endedBy) => {
  const open = openSegment(session);
  if (!open) return null;
  const endedAt = new Date(Math.max(ms(open.startedAt), ms(at)));
  open.endedAt = endedAt;
  open.endedBy = endedBy;
  return endedAt;
};

/** Re-derives the stored projection. Called after every change to segments. */
const syncActiveMs = (session, now) => {
  session.activeMs = totalsFor(session, now).activeMs;
};

/**
 * Brings a stored session up to date with the clock, saving if anything moved.
 *
 * The two things that happen without anyone pressing a button:
 *
 *   - the person stopped being there, so the timer must stop counting;
 *   - the day ended, so a session nobody closed must not stay open forever and
 *     block tomorrow.
 *
 * A session still being worked past midnight is deliberately left running.
 * People do work late, and cutting someone off at 00:00 while they are visibly
 * active would discard real work. It closes on its own as soon as they stop -
 * the idle rule fires, and then the stale-day rule finishes the day.
 *
 * @returns {Promise<{ session: object, transitions: string[] }>} Transitions
 *   name what changed ("auto_paused", "auto_finished") so the caller can notify
 *   on them. An unchanged session returns an empty list, which is what keeps
 *   the sweeper silent on a quiet minute.
 */
async function reconcile(session, now = new Date()) {
  const transitions = [];
  if (!session || session.status === "completed") {
    return { session, transitions };
  }

  const nowMs = ms(now);

  // -- The day ran away with itself -------------------------------------
  // Checked before inactivity: a session over the cap is finished outright,
  // and its work is counted only to the cap or the last sign of life,
  // whichever came first.
  if (nowMs - ms(session.startedAt) > maxSessionMs()) {
    const cap = new Date(ms(session.startedAt) + maxSessionMs());
    const cutAt = new Date(Math.min(ms(cap), ms(session.lastActivityAt)));
    closeOpenSegment(session, cutAt, "system");
    closeTaskSpans(session, cutAt);
    session.status = "completed";
    session.finishedAt = cutAt;
    session.finishedBy = "system";
    record(session, "auto_finished", cutAt, {
      actor: "system",
      note: `Closed automatically after ${CONFIG.maxSessionHours} hours.`,
    });
    syncActiveMs(session, now);
    await session.save();
    return { session, transitions: ["auto_finished"] };
  }

  // -- Nobody has been there for a while ---------------------------------
  // Only while the idle rule is on. With it off a running timer is stopped by
  // the employee and by nothing else, and the hard cap above is all that can
  // close a day nobody closed.
  if (autoPauses() && session.status === "working") {
    const silentFor = nowMs - ms(session.lastActivityAt);
    if (silentFor >= idleMs()) {
      const cutAt = new Date(session.lastActivityAt);
      closeOpenSegment(session, cutAt, "inactivity");
      session.status = "paused";
      record(session, "auto_paused", cutAt, {
        actor: "system",
        note: `No activity for ${CONFIG.idleTimeoutMinutes} minutes.`,
      });
      transitions.push("auto_paused");
    }
  }

  // -- The day itself is over --------------------------------------------
  // Only a paused session is closed this way. One still being worked is left
  // alone above; it will land here on the next pass after it goes idle.
  if (session.status === "paused" && session.date < today()) {
    const closedAt = lastWorkedAt(session) || session.lastActivityAt;
    closeTaskSpans(session, closedAt);
    session.status = "completed";
    session.finishedAt = closedAt;
    session.finishedBy = "system";
    record(session, "auto_finished", closedAt, {
      actor: "system",
      note: "Closed automatically at the end of the work-from-home day.",
    });
    transitions.push("auto_finished");
  }

  if (transitions.length) {
    syncActiveMs(session, now);
    await session.save();
  }

  return { session, transitions };
}

/**
 * The approved request that permits this employee to work from home on a day.
 *
 * Only `approved` counts. A pending request grants nothing, which is what keeps
 * the approval meaningful - the same rule workModeService applies when it
 * decides how a day was worked.
 */
async function approvedRequestFor(employeeId, companyId, date = today()) {
  return WorkFromHome.findOne({
    employee: employeeId,
    company: companyId,
    status: "approved",
    startDate: { $lte: new Date(`${date}T23:59:59.999Z`) },
    endDate: { $gte: new Date(`${date}T00:00:00.000Z`) },
  }).lean();
}

/**
 * Closes out anything this employee left open on an earlier day.
 *
 * Called before a new day starts. Without it, an employee who never pressed
 * Finish yesterday would be carrying a session that the stale-day rule has not
 * been asked about yet, and "one timer per person" would depend on the sweeper
 * having run rather than on anything structural.
 */
async function closeStaleSessions(employeeId, now = new Date()) {
  const stale = await WfhWorkSession.find({
    employee: employeeId,
    status: { $in: ["working", "paused"] },
    date: { $lt: today() },
  });

  const closed = [];
  for (const session of stale) {
    // Force the day closed even if it is still heartbeating: a new day cannot
    // start while yesterday's is open, and the employee is plainly at today's
    // desk, not yesterday's.
    if (session.status === "working") {
      closeOpenSegment(session, session.lastActivityAt, "system");
    }
    session.status = "completed";
    session.finishedAt = lastWorkedAt(session) || session.lastActivityAt;
    closeTaskSpans(session, session.finishedAt);
    session.finishedBy = "system";
    record(session, "auto_finished", session.finishedAt, {
      actor: "system",
      note: "Closed automatically when a new work-from-home day began.",
    });
    syncActiveMs(session, now);
    await session.save();
    closed.push(session);
  }
  return closed;
}

/**
 * Starts the day.
 *
 * The duplicate-start guard is the unique index on `{ employee, date }`, not a
 * read-then-write check: two tabs clicking together, or a client retrying a
 * request whose response was lost, both reach the database at once and exactly
 * one of them creates the document. The loser gets 11000 and is answered with
 * the session that won, so a retry looks like success rather than an error.
 */
async function start({ user, now = new Date() }) {
  const date = localDateString(now);

  const request = await approvedRequestFor(user._id, user.company._id, date);
  if (!request) {
    throw new SessionRuleError(
      "You do not have an approved work from home day for today.",
      { status: 403, code: "no_approved_day" }
    );
  }

  await closeStaleSessions(user._id, now);

  const existing = await WfhWorkSession.findOne({
    employee: user._id,
    date,
  });
  if (existing) {
    const { session } = await reconcile(existing, now);
    if (session.status === "completed") {
      throw new SessionRuleError(
        "You have already finished your work from home day. Today's record is closed.",
        { status: 409, code: "already_completed" }
      );
    }
    if (session.status === "paused") {
      throw new SessionRuleError(
        "Your work session is paused. Use Resume Work to continue it.",
        { status: 409, code: "already_paused" }
      );
    }
    // Already running: the click was a duplicate, so hand back the timer that
    // is already going rather than reporting a failure.
    return { session, created: false };
  }

  const planned = plannedTimesOf(request);

  /**
   * The day opens on the first task the employee said they would do.
   *
   * Picking one for them is the friendlier default and the honest one: the
   * timer has something to show from the first second, and they said this is
   * what they would be doing. Any of it is one click to change, and a request
   * that listed nothing simply starts with no task, exactly as every day did
   * before tasks existed.
   */
  const tasks = plannedTasksOf(request).map((title, index) => ({
    title,
    source: "planned",
    status: index === 0 ? "active" : "pending",
    startedAt: index === 0 ? now : null,
    completedAt: null,
    spans: index === 0 ? [{ from: now, to: null }] : [],
  }));

  const events = [{ type: "started", at: now, actor: "employee", note: "" }];
  if (tasks.length) {
    events.push({
      type: "task_started",
      at: now,
      actor: "employee",
      note: tasks[0].title,
    });
  }

  try {
    const session = await WfhWorkSession.create({
      employee: user._id,
      company: user.company._id,
      request: request._id,
      date,
      plannedStartTime: planned.start,
      plannedEndTime: planned.end,
      status: "working",
      startedAt: now,
      lastActivityAt: now,
      segments: [{ startedAt: now, endedAt: null, endedBy: null }],
      tasks,
      events,
      activeMs: 0,
    });
    return { session, created: true };
  } catch (error) {
    if (error && error.code === 11000) {
      // Another tab won the race. Its session is the real one.
      const winner = await WfhWorkSession.findOne({
        employee: user._id,
        date,
      });
      if (winner) return { session: winner, created: false };
    }
    throw error;
  }
}

/** The employee stops the clock on purpose. */
async function pause({ user, now = new Date() }) {
  const session = await requireOpenSession(user, now);

  if (session.status !== "working") {
    throw new SessionRuleError("Your work session is not running.", {
      status: 409,
      code: "not_working",
    });
  }

  closeOpenSegment(session, now, "employee");
  session.status = "paused";
  session.lastActivityAt = now;
  record(session, "paused", now);
  syncActiveMs(session, now);
  await session.save();
  return session;
}

/**
 * The employee confirms they are back.
 *
 * Always an explicit action, never inferred from a stray mouse move. Resuming
 * silently would mean the system decided on its own that someone had returned
 * to their desk and started charging time for it, which is exactly the kind of
 * claim this feature exists to stop making.
 */
async function resume({ user, now = new Date() }) {
  const session = await requireOpenSession(user, now);

  if (session.status !== "paused") {
    throw new SessionRuleError("Your work session is already running.", {
      status: 409,
      code: "not_paused",
    });
  }

  // A new stretch on the same session. The day is never restarted, so the
  // summary still reads one day with several stretches inside it.
  session.segments.push({ startedAt: now, endedAt: null, endedBy: null });
  session.status = "working";
  session.lastActivityAt = now;
  record(session, "resumed", now);
  syncActiveMs(session, now);
  await session.save();
  return session;
}

/** The employee closes the day. */
async function finish({ user, now = new Date() }) {
  const session = await requireOpenSession(user, now);

  closeOpenSegment(session, now, "employee");
  closeTaskSpans(session, now);
  session.status = "completed";
  session.lastActivityAt = now;
  // The instant Finish was pressed. When work actually stopped is
  // `lastWorkedAt`, which is earlier whenever the day ended on a pause - that
  // is the one the summary shows as the actual end.
  session.finishedAt = now;
  session.finishedBy = "employee";
  record(session, "finished", now);
  syncActiveMs(session, now);
  await session.save();
  return session;
}

// ------------------------------------------------------- Task transitions
//
// All three share one shape: they act on an open session, they never touch a
// segment, and they treat the click as a sign of life like any other action.
// Nothing here can add or remove worked time - only change what the time
// already being counted is counted AGAINST.

/** The task with this id, or a rule error naming why it cannot be used. */
const requireTask = (session, taskId) => {
  const task = session.tasks.id(taskId);
  if (!task) {
    throw new SessionRuleError("That task is not on today's list.", {
      status: 404,
      code: "no_task",
    });
  }
  return task;
};

/**
 * Adds a piece of work that was not on the request.
 *
 * Days turn up work nobody foresaw, and a list that cannot grow would either
 * be abandoned by lunchtime or filled in dishonestly. Added tasks are marked as
 * such, so a day made entirely of unplanned work is still visibly that.
 *
 * It becomes the task in hand only when nothing else is - starting it over
 * whatever is already running would silently move time from one task to
 * another on what reads as a bookkeeping action.
 */
async function addTask({ user, title, now = new Date() }) {
  const session = await requireOpenSession(user, now);
  const text = String(title || "").trim().slice(0, 200);

  if (!text) {
    throw new SessionRuleError("Give the task a name.", {
      status: 400,
      code: "task_title_required",
    });
  }
  if ((session.tasks || []).length >= MAX_TASKS) {
    throw new SessionRuleError(
      `A single day cannot hold more than ${MAX_TASKS} tasks.`,
      { status: 400, code: "too_many_tasks" }
    );
  }

  const takesOver = !activeTask(session);

  session.tasks.push({
    title: text,
    source: "added",
    status: takesOver ? "active" : "pending",
    startedAt: takesOver ? now : null,
    completedAt: null,
    spans: takesOver ? [{ from: now, to: null }] : [],
  });

  record(session, "task_added", now, { note: text });
  if (takesOver) record(session, "task_started", now, { note: text });

  session.lastActivityAt = now;
  syncActiveMs(session, now);
  await session.save();
  return session;
}

/**
 * Switches to a task.
 *
 * The previous one is put down rather than abandoned: its span closes here and
 * a new one opens if it is ever picked up again, so a task returned to three
 * times reads as three stretches adding up to one total. Nothing is lost by
 * switching and nothing is gained by it.
 */
async function startTask({ user, taskId, now = new Date() }) {
  const session = await requireOpenSession(user, now);
  const task = requireTask(session, taskId);

  if (task.status === "completed") {
    throw new SessionRuleError(
      "That task is already done. Add it again if there is more to do.",
      { status: 409, code: "task_completed" }
    );
  }
  // Already the one in hand. Answering with the session rather than an error
  // makes a duplicate click - or a retried request - look like success.
  if (task.status === "active") return session;

  const current = activeTask(session);
  if (current) {
    closeTaskSpan(current, now);
    current.status = "pending";
  }

  task.status = "active";
  if (!task.startedAt) task.startedAt = now;
  task.spans.push({ from: now, to: null });

  record(session, "task_started", now, { note: task.title });
  session.lastActivityAt = now;
  syncActiveMs(session, now);
  await session.save();
  return session;
}

/**
 * Marks a task done.
 *
 * Nothing starts in its place. The employee says what they moved on to, because
 * the alternative is the system deciding on their behalf which task the next
 * hour belongs to - and a task total nobody chose is worth less than no total
 * at all.
 */
async function completeTask({ user, taskId, now = new Date() }) {
  const session = await requireOpenSession(user, now);
  const task = requireTask(session, taskId);

  if (task.status === "completed") return session;

  closeTaskSpan(task, now);
  task.status = "completed";
  task.completedAt = now;
  if (!task.startedAt) task.startedAt = now;

  record(session, "task_completed", now, { note: task.title });
  session.lastActivityAt = now;
  syncActiveMs(session, now);
  await session.save();
  return session;
}

/**
 * "Still here."
 *
 * Reconciled BEFORE the timestamp moves, and that order is the whole point. A
 * tab that was suspended for an hour and then fires one heartbeat must not be
 * able to extend the stretch it was in the middle of; it finds its session
 * already cut back and paused, and the employee has to say they are back. A
 * heartbeat therefore cannot add time - it can only keep time that is already
 * being counted from being taken away.
 *
 * While paused it changes nothing at all.
 */
async function heartbeat({ user, now = new Date() }) {
  const session = await WfhWorkSession.findOne({
    employee: user._id,
    date: localDateString(now),
  });
  if (!session) {
    throw new SessionRuleError("No work session has been started today.", {
      status: 404,
      code: "no_session",
    });
  }

  const { session: current, transitions } = await reconcile(session, now);

  if (current.status === "working") {
    current.lastActivityAt = now;
    current.activeMs = totalsFor(current, now).activeMs;
    await current.save();
  }

  return { session: current, transitions };
}

/**
 * The employee's session for today, reconciled, or null.
 *
 * Shared by pause, resume and finish so all three fail the same way on a day
 * that was never started or is already closed.
 */
async function requireOpenSession(user, now) {
  const session = await WfhWorkSession.findOne({
    employee: user._id,
    date: localDateString(now),
  });
  if (!session) {
    throw new SessionRuleError(
      "You have not started a work session today.",
      { status: 404, code: "no_session" }
    );
  }

  const { session: current } = await reconcile(session, now);
  if (current.status === "completed") {
    throw new SessionRuleError(
      "Today's work from home session is already closed.",
      { status: 409, code: "already_completed" }
    );
  }
  return current;
}

// ------------------------------------------------------------ Presentation

/**
 * The planned window on a request, tolerating the ones raised before planned
 * times existed. Those simply have no plan, and every screen renders that as
 * "not set" rather than inventing one.
 */
function plannedTimesOf(request) {
  return {
    start: (request && request.plannedStartTime) || "",
    end: (request && request.plannedEndTime) || "",
  };
}

/**
 * The wire shape every client reads. One serializer, so the employee's card,
 * the admin monitor and the history drawer cannot render different numbers for
 * the same session.
 */
function serialize(session, now = new Date()) {
  if (!session) return null;
  const doc = session.toObject ? session.toObject() : session;
  const totals = totalsFor(doc, now);
  const open = openSegment(doc);
  const perTask = taskBreakdown(doc, now);
  const current = activeTask(doc);

  return {
    _id: doc._id,
    employee: doc.employee,
    company: doc.company,
    request: doc.request,
    date: doc.date,
    status: doc.status,
    plannedStartTime: doc.plannedStartTime || "",
    plannedEndTime: doc.plannedEndTime || "",
    startedAt: doc.startedAt,
    finishedAt: doc.finishedAt || null,
    finishedBy: doc.finishedBy || null,
    /** When work actually stopped - the summary's "Actual End". */
    lastWorkedAt: lastWorkedAt(doc),
    lastActivityAt: doc.lastActivityAt,
    activeMs: totals.activeMs,
    idleMs: totals.idleMs,
    segmentCount: totals.segmentCount,
    /**
     * The instant `activeMs` is counted to while the timer runs. The card ticks
     * forward from here for display only, and stops the moment the browser
     * stops seeing activity.
     */
    countingSince:
      doc.status === "working" && open ? new Date(countedUpTo(doc, now)) : null,
    /**
     * When the server will stop counting if nothing else arrives. Lets the card
     * show the pause coming rather than announcing it after the fact. Null
     * while the idle rule is off - nothing is coming.
     */
    idleDeadline:
      doc.status === "working" && autoPauses()
        ? new Date(ms(doc.lastActivityAt) + idleMs())
        : null,
    segments: (doc.segments || []).map((segment) => ({
      startedAt: segment.startedAt,
      endedAt: segment.endedAt || null,
      endedBy: segment.endedBy || null,
      durationMs: segment.endedAt
        ? Math.max(0, ms(segment.endedAt) - ms(segment.startedAt))
        : Math.max(0, countedUpTo(doc, now) - ms(segment.startedAt)),
    })),
    /**
     * What is being worked on, and what each piece has taken so far.
     *
     * The per-task figures are computed here from the spans and the segments
     * rather than stored, for the same reason `idleMs` is: two stored numbers
     * about one day can drift apart, and a card showing a total that disagrees
     * with the tasks under it is worse than either number alone.
     */
    tasks: (doc.tasks || []).map((task) => {
      const entry = perTask.get(String(task._id)) || { activeMs: 0, spans: [] };
      return {
        _id: String(task._id),
        title: task.title,
        status: task.status,
        startedAt: task.startedAt || null,
        completedAt: task.completedAt || null,
        source: task.source || "added",
        activeMs: entry.activeMs,
        /** When it was worked on, and how much of each stretch counted. */
        spans: entry.spans,
      };
    }),
    /** The one task in hand, lifted out so no screen has to search for it. */
    currentTask: current
      ? {
          _id: String(current._id),
          title: current.title,
          activeMs: (perTask.get(String(current._id)) || {}).activeMs || 0,
        }
      : null,
    events: doc.events || [],
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

/**
 * The bucket index a repeatable notification falls in.
 *
 * Turning "at most once every N minutes" into a value makes the throttle a
 * uniqueness constraint rather than a timer: the key goes into the
 * notification's dedupeKey, and the unique index settles it even when the
 * sweeper and a live request decide to notify in the same instant.
 */
const throttleBucket = (now = new Date()) =>
  Math.floor(ms(now) / (CONFIG.notifyThrottleMinutes * 60 * 1000));

module.exports = {
  CONFIG,
  getConfig,
  SessionRuleError,
  totalsFor,
  openSegment,
  lastWorkedAt,
  reconcile,
  approvedRequestFor,
  closeStaleSessions,
  start,
  pause,
  resume,
  finish,
  heartbeat,
  addTask,
  startTask,
  completeTask,
  taskTotals,
  taskBreakdown,
  activeTask,
  serialize,
  plannedTimesOf,
  throttleBucket,
};
