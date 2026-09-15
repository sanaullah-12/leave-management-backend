const mongoose = require("mongoose");

/**
 * WfhWorkSession - one employee's actual working day at home.
 *
 * A sibling of WorkFromHome rather than a field on it. The request answers
 * "was this day agreed?"; this answers "what was actually worked?". They have
 * different lifetimes (a request is decided once, a session is written to all
 * day), different readers, and a request can span a week while a session is
 * always exactly one day.
 *
 * The day is the document. `segments` are the stretches actually worked inside
 * it - start to pause, resume to pause, resume to finish - so "3 sessions" in
 * the end-of-day summary is `segments.length`, and active time is their sum.
 * Paused time is never stored: it is the gap between segments, which means it
 * cannot disagree with them.
 *
 * Two structural guarantees, neither of which is a rule someone has to
 * remember:
 *
 *   - `{ employee, date }` is unique, so an employee cannot have two sessions
 *     for one day no matter how many times Start is pressed or how many tabs
 *     are open. A duplicate start is a duplicate-key error, not a second timer.
 *   - At most one segment is ever open (`endedAt` unset), enforced on every
 *     transition in wfhSessionService. A second open segment would be the only
 *     way to double-count time, and there is no path that creates one.
 *
 * Every timestamp in here is stamped by the server. Nothing the browser sends
 * is written to a date field - see routes/wfhSessions.js.
 */

/**
 * A stretch of actual work.
 *
 * `endedBy` records why it stopped, which is what separates "they went to
 * lunch" from "they walked away and the system noticed" when someone reads the
 * day back a week later.
 */
const segmentSchema = new mongoose.Schema(
  {
    startedAt: { type: Date, required: true },
    /** Unset while the segment is running. At most one such segment exists. */
    endedAt: { type: Date, default: null },
    endedBy: {
      type: String,
      enum: ["employee", "inactivity", "system"],
      default: null,
    },
  },
  { _id: false }
);

/**
 * A stretch of the day spent on one task.
 *
 * Deliberately separate from `segments`. A segment says the employee was
 * working; a span says what they were working on. Time for a task is the
 * overlap of the two, which is what stops a task accruing minutes across a
 * lunch break: the span stays open, the segment does not, and an overlap with
 * nothing is nothing.
 *
 * Keeping them apart also means switching task can never create or destroy
 * worked time. The segments are untouched by it, so the day's total is the same
 * number however the tasks underneath it are arranged.
 */
const taskSpanSchema = new mongoose.Schema(
  {
    from: { type: Date, required: true },
    /** Unset while this is the task being worked on. */
    to: { type: Date, default: null },
  },
  { _id: false }
);

/**
 * One piece of work inside the day.
 *
 * `title` is whatever the employee typed - a line of text, never parsed,
 * matched or acted on. The system records that a task was worked and for how
 * long; it has no opinion about what the task is.
 *
 * At most one task is ever `active`, enforced on every transition in
 * wfhSessionService. A second active task would be the only way for one minute
 * of work to be counted against two tasks, and there is no path that creates
 * one.
 */
const taskSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true,
    trim: true,
    maxlength: [200, "A task cannot exceed 200 characters"],
  },
  status: {
    type: String,
    enum: ["pending", "active", "completed"],
    default: "pending",
  },
  /** First time this task was picked up. Null while it is still pending. */
  startedAt: { type: Date, default: null },
  completedAt: { type: Date, default: null },
  spans: { type: [taskSpanSchema], default: [] },
  /**
   * Whether it came from the request or was added during the day.
   *
   * Worth keeping: a day made entirely of tasks nobody mentioned when asking
   * for it is a different day from the one that was approved, and only this
   * distinguishes them.
   */
  source: {
    type: String,
    enum: ["planned", "added"],
    default: "added",
  },
});

/**
 * The audit trail. Append-only: nothing in the service updates or removes an
 * entry, so the history of a disputed day is whatever actually happened.
 */
const eventSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: [
        "started",
        "paused",
        "auto_paused",
        "resumed",
        "finished",
        "auto_finished",
        "task_started",
        "task_completed",
        "task_added",
      ],
      required: true,
    },
    at: { type: Date, required: true },
    /** Who caused it: the person, or the server's own reconciliation. */
    actor: {
      type: String,
      enum: ["employee", "system"],
      default: "employee",
    },
    /** Short human note, e.g. why the server closed a day on its own. */
    note: { type: String, default: "" },
  },
  { _id: false }
);

const wfhWorkSessionSchema = new mongoose.Schema(
  {
    employee: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: [true, "A work session must belong to an employee"],
    },
    company: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: [true, "A work session must belong to a company"],
    },
    /** The approved request that permitted this day. */
    request: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "WorkFromHome",
      required: [true, "A work session must cite the request that allowed it"],
    },
    /**
     * The working day, YYYY-MM-DD in the office timezone (utils/timezone).
     *
     * A string rather than a Date because it is a calendar day, not an instant:
     * stored as a Date it would need a timezone to be read back, and the answer
     * would differ between a UTC server and a developer laptop.
     */
    date: {
      type: String,
      required: [true, "A work session must name its day"],
      match: [/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD"],
    },

    /**
     * The schedule the employee said they would keep, snapshotted from the
     * request when the day starts.
     *
     * Copied rather than read through so the summary of a finished day still
     * shows what was planned at the time, even if the request is later edited.
     * Plain "HH:MM" wall-clock in the office timezone - a plan is a time of
     * day, not an instant, and pinning it to one would move it under DST.
     */
    plannedStartTime: { type: String, default: "" },
    plannedEndTime: { type: String, default: "" },

    status: {
      type: String,
      enum: ["working", "paused", "completed"],
      required: true,
      default: "working",
    },

    /** First press of Start. Never moves, even across pauses. */
    startedAt: { type: Date, required: true },
    /** Set once, when the day is closed by the employee or by the server. */
    finishedAt: { type: Date, default: null },
    finishedBy: {
      type: String,
      enum: ["employee", "system"],
      default: null,
    },

    /**
     * The last moment the server saw a sign of life: a heartbeat, or any of
     * the four actions.
     *
     * This is what makes inactivity honest. When a segment is closed for
     * inactivity it is cut back to THIS instant, not to the moment the server
     * noticed, so the idle minutes are never counted. It is also what makes a
     * closed laptop, a killed tab and a dropped connection all behave the same
     * way: they stop updating it, and the next read cuts the segment back.
     */
    lastActivityAt: { type: Date, required: true },

    segments: { type: [segmentSchema], default: [] },

    /**
     * What is being worked on, in the order it was picked up.
     *
     * Seeded from the request's planned tasks when the day starts, and added to
     * during the day as work turns up that nobody foresaw. An empty list is a
     * perfectly ordinary day: the timer works exactly as it did before tasks
     * existed, and every session recorded before them has one.
     */
    tasks: { type: [taskSchema], default: [] },

    events: { type: [eventSchema], default: [] },

    /**
     * Sum of the closed segments, in milliseconds.
     *
     * A projection of `segments`, never an independent number: every write
     * recomputes it from them. Stored so the admin monitor can sort and report
     * on worked time without unwinding an array per row.
     */
    activeMs: { type: Number, default: 0 },

    /** Policy snapshots, client hints, anything V2 needs. Untyped on purpose. */
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  { timestamps: true }
);

/**
 * One session per employee per day - the guarantee, not a convention.
 *
 * Everything that could create a second timer (a double click, two tabs, a
 * retried request, two servers behind a load balancer) collides here and loses.
 */
wfhWorkSessionSchema.index({ employee: 1, date: 1 }, { unique: true });

// The admin monitor: today's sessions for a company, newest first.
wfhWorkSessionSchema.index({ company: 1, date: -1, status: 1 });
// The sweeper: every session still open, across companies.
wfhWorkSessionSchema.index({ status: 1, lastActivityAt: 1 });
// An employee's own history, and the request-scoped view of a range.
wfhWorkSessionSchema.index({ employee: 1, date: -1 });
wfhWorkSessionSchema.index({ request: 1 });

module.exports = mongoose.model("WfhWorkSession", wfhWorkSessionSchema);
