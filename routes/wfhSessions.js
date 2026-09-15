const express = require("express");
const { authenticateToken, authorizeRoles } = require("../middleware/auth");
const WfhWorkSession = require("../models/WfhWorkSession");
const WorkFromHome = require("../models/WorkFromHome");
const wfhSessionService = require("../services/wfhSessionService");
const wfhSessionNotifier = require("../services/wfhSessionNotifier");
const { today } = require("../utils/timezone");

/**
 * Work From Home - the working day
 * --------------------------------
 * Start, pause, resume and finish an actual work session on an approved
 * work-from-home day, plus the two views onto it: the employee's own card and
 * the admin's live monitor.
 *
 * A companion to routes/workFromHome.js rather than more routes inside it. That
 * file answers "may this day be worked away from the office?" and is written
 * once per request; this one answers "what is being worked right now?" and is
 * written all day by a browser that is open the whole time. They have different
 * shapes, different readers and different failure modes.
 *
 * -- What the client is and is not trusted with ---------------------------
 *
 * Every timestamp written by these routes comes from `new Date()` in this
 * process. No request body carries a time, a duration or a status, and none is
 * read if it does - so a modified page, a replayed request and a wrong system
 * clock all produce the same record as an honest click. The timer the employee
 * watches is a rendering of the server's numbers, never their source.
 *
 * The heartbeat carries no content whatsoever. It says a browser saw input; it
 * cannot say what the input was. See the employee card for what is watched
 * (mouse, keyboard, scroll, touch, tab visibility) and what is not - nothing is
 * captured, transmitted or stored about any of it.
 *
 * -- Why reads change things ----------------------------------------------
 *
 * Each of these handlers reconciles the sessions it touches before answering,
 * so a server that was restarted, or asleep, or simply not asked for two hours,
 * still returns the correct numbers the first time anyone looks. Correctness
 * comes from the stored timestamps, not from a process having been running at
 * the right moment.
 */

const router = express.Router();

/** The UTC instants bounding a local calendar day, for the request overlap query. */
const dayBounds = (date) => ({
  start: new Date(`${date}T00:00:00.000Z`),
  end: new Date(`${date}T23:59:59.999Z`),
});

/** A rule said no. Anything else is a fault and is reported as one. */
const fail = (res, error, fallback) => {
  if (error instanceof wfhSessionService.SessionRuleError) {
    return res
      .status(error.status)
      .json({ success: false, code: error.code, message: error.message });
  }
  console.error(`${fallback}:`, error);
  return res
    .status(500)
    .json({ success: false, message: fallback, error: error.message });
};

/**
 * Runs one of the four employee actions and announces what it changed.
 *
 * All four differ only in which service call they make and which transition
 * they announce, so the response shape, the error translation and the
 * announcement are written once.
 */
const action = (perform, transition) => async (req, res) => {
  try {
    const now = new Date();
    const session = await perform({ user: req.user, now });
    const payload = wfhSessionService.serialize(session, now);

    res.json({
      success: true,
      session: payload,
      config: wfhSessionService.getConfig(),
    });

    // After the response, as the leave and WFH request routes do: a slow
    // notification channel must never delay the button the employee pressed.
    setImmediate(() =>
      wfhSessionNotifier.announce({
        session: payload,
        transitions: [transition],
        employee: { _id: req.user._id, name: req.user.name },
        companyId: req.user.company._id,
      })
    );
  } catch (error) {
    fail(res, error, "Could not update the work session");
  }
};

// --------------------------------------------------------------- Employee

/**
 * GET /api/work-from-home/sessions/today
 *
 * Everything the employee's card needs in one call: whether today is an
 * approved work-from-home day, what they planned, and the session if one has
 * been started. `session` is null before the first Start - the absence of a
 * record is what "Not Started" means, so nothing is written until they act.
 */
router.get("/today", authenticateToken, async (req, res) => {
  try {
    const now = new Date();
    const date = today();

    const request = await wfhSessionService.approvedRequestFor(
      req.user._id,
      req.user.company._id,
      date
    );

    const stored = await WfhWorkSession.findOne({
      employee: req.user._id,
      date,
    });

    let session = null;
    if (stored) {
      const { session: current, transitions } = await wfhSessionService.reconcile(
        stored,
        now
      );
      session = wfhSessionService.serialize(current, now);
      if (transitions.length) {
        setImmediate(() =>
          wfhSessionNotifier.announce({
            session,
            transitions,
            employee: { _id: req.user._id, name: req.user.name },
            companyId: req.user.company._id,
          })
        );
      }
    }

    res.json({
      success: true,
      date,
      /** An approved day is the only thing that lets the timer be started. */
      eligible: !!request,
      request: request
        ? {
            _id: request._id,
            startDate: request.startDate,
            endDate: request.endDate,
            reason: request.reason,
            plannedStartTime: request.plannedStartTime || "",
            plannedEndTime: request.plannedEndTime || "",
            /** What the employee said they would work on. The day's task list
                is seeded from these the moment Start is pressed. */
            plannedTasks: request.plannedTasks || [],
          }
        : null,
      session,
      config: wfhSessionService.getConfig(),
    });
  } catch (error) {
    fail(res, error, "Could not load today's work from home session");
  }
});

router.post(
  "/start",
  authenticateToken,
  async (req, res) => {
    try {
      const now = new Date();
      const { session, created } = await wfhSessionService.start({
        user: req.user,
        now,
      });
      const payload = wfhSessionService.serialize(session, now);

      res.status(created ? 201 : 200).json({
        success: true,
        session: payload,
        config: wfhSessionService.getConfig(),
      });

      // Only a real start is announced. A duplicate click that found the timer
      // already running must not tell every admin a second time.
      if (created) {
        setImmediate(() =>
          wfhSessionNotifier.announce({
            session: payload,
            transitions: ["started"],
            employee: { _id: req.user._id, name: req.user.name },
            companyId: req.user.company._id,
          })
        );
      }
    } catch (error) {
      fail(res, error, "Could not start the work session");
    }
  }
);

router.post(
  "/pause",
  authenticateToken,
  action(wfhSessionService.pause, "paused")
);

router.post(
  "/resume",
  authenticateToken,
  action(wfhSessionService.resume, "resumed")
);

router.post(
  "/finish",
  authenticateToken,
  action(wfhSessionService.finish, "finished")
);

/**
 * POST /api/work-from-home/sessions/heartbeat
 *
 * "A browser belonging to this employee saw user input." That is the entire
 * message - the body is ignored, and there is nothing in it to ignore.
 *
 * It can only preserve time, never add it: the session is reconciled before the
 * activity timestamp moves, so a tab that was suspended for an hour finds its
 * stretch already cut back and paused, and the employee has to confirm they are
 * back. Answers the current session either way, so the card corrects itself
 * without a second request.
 */
router.post("/heartbeat", authenticateToken, async (req, res) => {
  try {
    const now = new Date();
    const { session, transitions } = await wfhSessionService.heartbeat({
      user: req.user,
      now,
    });
    const payload = wfhSessionService.serialize(session, now);

    res.json({ success: true, session: payload });

    if (transitions.length) {
      setImmediate(() =>
        wfhSessionNotifier.announce({
          session: payload,
          transitions,
          employee: { _id: req.user._id, name: req.user.name },
          companyId: req.user.company._id,
        })
      );
    }
  } catch (error) {
    fail(res, error, "Could not record work session activity");
  }
});

// ----------------------------------------------------------------- Tasks

/**
 * What the employee is working on, as three actions on the running day.
 *
 * Separate from the four timer actions on purpose, and quieter than them. A
 * task change is a real-time signal so the monitor and the employee's other
 * tabs redraw, but it raises no notification: nobody needs telling four times
 * an afternoon that somebody moved from one ticket to the next, and a feature
 * that produced that would be turned off within a week.
 *
 * Only the title is read from the body. Every instant is stamped here, exactly
 * as it is for Start, Pause, Resume and Finish - so a task's figures are as
 * unforgeable as the day's.
 */
const taskAction = (perform) => async (req, res) => {
  try {
    const now = new Date();
    const session = await perform({
      user: req.user,
      now,
      taskId: req.params.id,
      title: req.body && req.body.title,
    });
    const payload = wfhSessionService.serialize(session, now);

    res.json({
      success: true,
      session: payload,
      config: wfhSessionService.getConfig(),
    });

    // The live signal only. `transitions` names what happened for the benefit
    // of anything listening; it is not one of the four the notifier announces,
    // so no notification is raised for it anywhere.
    setImmediate(() =>
      wfhSessionNotifier.emitSessionUpdate({
        session: payload,
        companyId: req.user.company._id,
        employeeName: req.user.name,
        transitions: ["task_changed"],
      })
    );
  } catch (error) {
    fail(res, error, "Could not update the work session tasks");
  }
};

/** POST /api/work-from-home/sessions/tasks - add a task to today. */
router.post("/tasks", authenticateToken, taskAction(wfhSessionService.addTask));

/** POST /api/work-from-home/sessions/tasks/:id/start - switch to a task. */
router.post(
  "/tasks/:id/start",
  authenticateToken,
  taskAction(wfhSessionService.startTask)
);

/** POST /api/work-from-home/sessions/tasks/:id/complete - mark one done. */
router.post(
  "/tasks/:id/complete",
  authenticateToken,
  taskAction(wfhSessionService.completeTask)
);

// ------------------------------------------------------------ Live monitor

/**
 * GET /api/work-from-home/sessions/live
 *
 * Every employee approved to work from home today, and how their day is going.
 *
 * Built from the approved requests rather than from the sessions, which is what
 * makes "Not Started" a real row: someone who has an approved day and has not
 * pressed Start has no session document, and a list of sessions would simply
 * not contain them.
 *
 * Every session on the page is reconciled first, so an employee who walked away
 * an hour ago reads as paused here even if nobody has looked since.
 */
router.get(
  "/live",
  authenticateToken,
  authorizeRoles("admin"),
  async (req, res) => {
    try {
      const now = new Date();
      const date = req.query.date || today();
      const bounds = dayBounds(date);

      const [requests, stored] = await Promise.all([
        WorkFromHome.find({
          company: req.user.company._id,
          status: "approved",
          startDate: { $lte: bounds.end },
          endDate: { $gte: bounds.start },
        })
          .populate("employee", "name employeeId department profilePicture")
          .lean(),
        WfhWorkSession.find({ company: req.user.company._id, date }).populate(
          "employee",
          "name employeeId department profilePicture"
        ),
      ]);

      const sessionsByEmployee = new Map();
      for (const doc of stored) {
        const { session: current, transitions } =
          await wfhSessionService.reconcile(doc, now);
        const employee = current.employee;
        const payload = wfhSessionService.serialize(current, now);
        // The populated employee survives serialize as an object; the monitor
        // needs the name, so keep it and normalise the id alongside.
        sessionsByEmployee.set(String(employee._id || employee), {
          payload,
          employee,
          transitions,
        });
      }

      const rows = [];
      const seen = new Set();

      for (const request of requests) {
        const employee = request.employee;
        if (!employee) continue;
        const key = String(employee._id);
        // An employee cannot hold two approved requests for one day, but a row
        // per employee is the guarantee the monitor needs rather than an
        // assumption it makes.
        if (seen.has(key)) continue;
        seen.add(key);

        const entry = sessionsByEmployee.get(key);
        rows.push(buildRow({ employee, request, entry }));
      }

      // A session whose request was cancelled or amended after the day began
      // still describes work that was done, so it is shown rather than dropped.
      for (const [key, entry] of sessionsByEmployee) {
        if (seen.has(key)) continue;
        rows.push(buildRow({ employee: entry.employee, request: null, entry }));
      }

      res.json({
        success: true,
        date,
        rows,
        summary: summarise(rows),
        config: wfhSessionService.getConfig(),
      });

      // Anything the reconciliation above changed is announced once, after the
      // response - an admin opening the monitor is often how an idle employee
      // is first noticed.
      setImmediate(() => {
        for (const entry of sessionsByEmployee.values()) {
          if (!entry.transitions.length) continue;
          wfhSessionNotifier.announce({
            session: entry.payload,
            transitions: entry.transitions,
            employee: entry.employee,
            companyId: req.user.company._id,
          });
        }
      });
    } catch (error) {
      fail(res, error, "Could not load the work from home monitor");
    }
  }
);

/** One monitor row. The four states the brief names, and nothing derived twice. */
const buildRow = ({ employee, request, entry }) => ({
  employee: {
    _id: employee._id,
    name: employee.name,
    employeeId: employee.employeeId || "",
    department: employee.department || "",
    profilePicture: employee.profilePicture || "",
  },
  plannedStartTime:
    (request && request.plannedStartTime) ||
    (entry && entry.payload.plannedStartTime) ||
    "",
  plannedEndTime:
    (request && request.plannedEndTime) ||
    (entry && entry.payload.plannedEndTime) ||
    "",
  requestId: request ? request._id : entry ? entry.payload.request : null,
  /** "not_started" is the absence of a session, never a stored value. */
  status: entry ? entry.payload.status : "not_started",
  session: entry ? entry.payload : null,
});

const summarise = (rows) =>
  rows.reduce(
    (totals, row) => {
      totals[row.status] = (totals[row.status] || 0) + 1;
      totals.total += 1;
      totals.activeMs += row.session ? row.session.activeMs : 0;
      return totals;
    },
    { not_started: 0, working: 0, paused: 0, completed: 0, total: 0, activeMs: 0 }
  );

// ----------------------------------------------------------------- History

/**
 * GET /api/work-from-home/sessions/history
 *
 * Finished days, newest first. Admins see the company and may filter by
 * employee; everyone else sees only their own, which is the same scoping rule
 * the request list uses.
 *
 * Filters: ?employeeId=<mongoId>&from=YYYY-MM-DD&to=YYYY-MM-DD&status=completed
 */
router.get("/history", authenticateToken, async (req, res) => {
  try {
    const now = new Date();
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, parseInt(req.query.limit, 10) || 50);
    const isAdmin = req.user.role === "admin";

    const query = { company: req.user.company._id };
    if (!isAdmin) {
      query.employee = req.user._id;
    } else if (req.query.employeeId) {
      query.employee = req.query.employeeId;
    }
    if (["working", "paused", "completed"].includes(req.query.status)) {
      query.status = req.query.status;
    }
    if (req.query.from || req.query.to) {
      // The day is stored as YYYY-MM-DD text, which sorts and compares as a
      // date because the format is fixed-width and zero-padded.
      query.date = {};
      if (req.query.from) query.date.$gte = String(req.query.from).slice(0, 10);
      if (req.query.to) query.date.$lte = String(req.query.to).slice(0, 10);
    }

    const [sessions, total] = await Promise.all([
      WfhWorkSession.find(query)
        .populate("employee", "name employeeId department profilePicture")
        .sort({ date: -1, startedAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      WfhWorkSession.countDocuments(query),
    ]);

    const rows = [];
    for (const doc of sessions) {
      // A day still open in a historical list is reconciled like any other, so
      // a report never quotes a total that includes hours nobody worked.
      const { session: current } = await wfhSessionService.reconcile(doc, now);
      rows.push({
        ...wfhSessionService.serialize(current, now),
        employee: current.employee,
      });
    }

    res.json({
      success: true,
      sessions: rows,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    fail(res, error, "Could not load work from home session history");
  }
});

/**
 * GET /api/work-from-home/sessions/:id
 *
 * One day in full: every stretch worked and the whole audit trail. This is the
 * view a disputed day is settled with, so it hands back what was recorded
 * rather than a summary of it.
 *
 * Declared last so it cannot shadow /today, /live or /history.
 */
router.get("/:id", authenticateToken, async (req, res) => {
  try {
    const now = new Date();
    const query = { _id: req.params.id, company: req.user.company._id };
    if (req.user.role !== "admin") query.employee = req.user._id;

    const stored = await WfhWorkSession.findOne(query).populate(
      "employee",
      "name employeeId department profilePicture email"
    );
    if (!stored) {
      return res
        .status(404)
        .json({ success: false, message: "Work session not found" });
    }

    const { session: current } = await wfhSessionService.reconcile(stored, now);
    res.json({
      success: true,
      session: {
        ...wfhSessionService.serialize(current, now),
        employee: current.employee,
      },
    });
  } catch (error) {
    fail(res, error, "Could not load the work session");
  }
});

module.exports = router;
