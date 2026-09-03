const express = require("express");
const { authenticateToken, authorizeRoles } = require("../middleware/auth");
const WorkFromHome = require("../models/WorkFromHome");
const Leave = require("../models/Leave");
const User = require("../models/User");
const SocketService = require("../socket/socketService");
const {
  notifyWfhRequest,
  notifyWfhApproval,
  notifyWfhRejection,
} = require("../utils/notifications");
const workModeService = require("../services/workModeService");
const wfhPolicyService = require("../services/wfhPolicyService");
const unreportedAbsenceService = require("../services/unreportedAbsenceService");

/**
 * Work From Home
 * --------------
 * An employee asks to work a day, or a run of days, away from the office; an
 * admin approves or rejects it; the decision reaches the employee over the
 * existing Socket.IO notification layer.
 *
 * An approved request never touches a leave balance. That is not a rule
 * enforced here - it is structural: WFH records live in their own collection
 * and nothing in the leave balance calculation reads them.
 *
 * The routes mirror routes/leaves.js deliberately, so the two read the same
 * way and share the same client patterns.
 */

const router = express.Router();

const VALID_STATUSES = ["pending", "approved", "rejected", "cancelled"];

/** YYYY-MM-DD in UTC for a Date, used for overlap messages. */
const isoDay = (value) => new Date(value).toISOString().slice(0, 10);

/**
 * A YYYY-MM-DD as its UTC midnight instant, plus the end of that same day.
 *
 * Stored requests use the midnight form at BOTH ends. An end stored at
 * 23:59:59 reads as the next calendar day once converted to the office
 * timezone, which would silently grant a day nobody asked for; the end-of-day
 * value is only ever used as a query bound.
 */
const dayBounds = (value) => {
  const day = String(value).slice(0, 10);
  return {
    start: new Date(`${day}T00:00:00.000Z`),
    end: new Date(`${day}T23:59:59.999Z`),
  };
};

const serialize = (doc) => (doc.toObject ? doc.toObject() : doc);

// ---------------------------------------------------------------- Submit

/**
 * POST /api/work-from-home
 * Employee submits a request. Admins may submit for themselves too - the
 * route does not gate on role, only the review route does.
 */
router.post("/", authenticateToken, async (req, res) => {
  try {
    const { startDate, endDate, reason, note } = req.body;

    if (!startDate || !reason || !String(reason).trim()) {
      return res
        .status(400)
        .json({ success: false, message: "A date and a reason are required" });
    }

    // A single-day request may omit the end date. Both ends are stored at
    // midnight; `endOfDay` is only for the overlap queries below.
    const { start } = dayBounds(startDate);
    const { start: end, end: endOfDay } = dayBounds(endDate || startDate);

    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid date supplied" });
    }

    // Backdating is allowed inside the policy window. Someone who worked from
    // home on Monday and remembers on Wednesday would otherwise be stuck with
    // two days recorded as absent, and a false record is worse than a late
    // request. Approving it fixes those days retroactively, because a work
    // mode is resolved when attendance is read, never stored on a punch.
    const policy = await wfhPolicyService.getPolicy(req.user.company._id);
    const verdict = wfhPolicyService.validateDates({
      startDate: String(startDate).slice(0, 10),
      endDate: String(endDate || startDate).slice(0, 10),
      policy,
    });
    if (!verdict.ok) {
      return res.status(400).json({ success: false, message: verdict.message });
    }

    // Overlap with the employee's own live WFH requests.
    const overlappingWfh = await WorkFromHome.findOne({
      employee: req.user._id,
      status: { $in: ["pending", "approved"] },
      startDate: { $lte: endOfDay },
      endDate: { $gte: start },
    });
    if (overlappingWfh) {
      return res.status(400).json({
        success: false,
        message: `You already have a ${
          overlappingWfh.status
        } work from home request covering ${isoDay(
          overlappingWfh.startDate
        )} to ${isoDay(overlappingWfh.endDate)}.`,
      });
    }

    // Overlap with leave. Being away and working from home are different
    // claims about the same day, and only one of them can be true.
    //
    // Leave the system raised for an unreported absence is the exception: it
    // is a placeholder for a day nobody explained, and this request is the
    // explanation. Blocking it here would trap the employee - the rule charged
    // them a day and the only route to undoing it would be closed. Approval
    // revokes that leave and returns the day.
    const overlappingLeave = await Leave.findOne({
      employee: req.user._id,
      status: { $in: ["pending", "approved"] },
      isAutoMarked: { $ne: true },
      startDate: { $lte: endOfDay },
      endDate: { $gte: start },
    });
    if (overlappingLeave) {
      return res.status(400).json({
        success: false,
        message: `You have a ${
          overlappingLeave.status
        } leave request covering ${isoDay(
          overlappingLeave.startDate
        )} to ${isoDay(
          overlappingLeave.endDate
        )}. Cancel it first if you intend to work from home instead.`,
      });
    }

    const request = new WorkFromHome({
      employee: req.user._id,
      company: req.user.company._id,
      startDate: start,
      endDate: end,
      reason: String(reason).trim(),
      note: note ? String(note).trim() : "",
      isBackdated: verdict.isBackdated,
    });

    await request.save();
    await request.populate(
      "employee",
      "name employeeId department profilePicture"
    );

    // Real-time: every admin's queue, badge and dashboard react at once.
    SocketService.toCompanyAdmins(
      request.company,
      SocketService.events.WFH_NEW,
      {
        _id: request._id,
        employeeName: request.employee && request.employee.name,
        totalDays: request.totalDays,
        startDate: request.startDate,
        endDate: request.endDate,
        status: request.status,
        isBackdated: request.isBackdated,
      }
    );
    SocketService.statsUpdate(request.company, "wfh");

    res.status(201).json({
      success: true,
      message: "Work from home request submitted",
      request: serialize(request),
    });

    // Notifications are sent after the response, as the leave route does, so a
    // slow channel can never delay or fail the submission itself.
    setImmediate(async () => {
      try {
        const admins = await User.find({
          company: req.user.company._id,
          role: "admin",
          status: "active",
        });
        await Promise.allSettled(
          admins.map((admin) => notifyWfhRequest(request, admin))
        );
      } catch (error) {
        console.error("WFH request notification failed:", error.message);
      }
    });
  } catch (error) {
    console.error("WFH submission error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to submit the work from home request",
      error: error.message,
    });
  }
});

// ------------------------------------------------------------------ Read

/**
 * GET /api/work-from-home
 * Admins see the company queue; everyone else sees only their own requests.
 * Filters: ?status=pending&employeeId=<mongoId>&from=YYYY-MM-DD&to=YYYY-MM-DD
 */
router.get("/", authenticateToken, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, parseInt(req.query.limit, 10) || 50);
    const isAdmin = req.user.role === "admin";

    const query = { company: req.user.company._id };
    if (!isAdmin) {
      query.employee = req.user._id;
    } else if (req.query.employeeId) {
      query.employee = req.query.employeeId;
    }

    if (req.query.status && VALID_STATUSES.includes(req.query.status)) {
      query.status = req.query.status;
    }
    if (req.query.from || req.query.to) {
      const from = req.query.from
        ? dayBounds(req.query.from).start
        : new Date(0);
      const to = req.query.to
        ? dayBounds(req.query.to).end
        : new Date("2999-12-31T23:59:59.999Z");
      query.startDate = { $lte: to };
      query.endDate = { $gte: from };
    }

    const [requests, total] = await Promise.all([
      WorkFromHome.find(query)
        .populate("employee", "name employeeId department profilePicture email")
        .populate("reviewedBy", "name")
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      WorkFromHome.countDocuments(query),
    ]);

    res.json({
      success: true,
      requests,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    console.error("WFH list error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to load work from home requests",
      error: error.message,
    });
  }
});

/**
 * GET /api/work-from-home/stats
 * Counts by status for the badge and the dashboard chips. Scoped the same way
 * the list is: an employee's own, an admin's whole company.
 */
router.get("/stats", authenticateToken, async (req, res) => {
  try {
    const match = { company: req.user.company._id };
    if (req.user.role !== "admin") match.employee = req.user._id;

    const rows = await WorkFromHome.aggregate([
      { $match: match },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]);

    const byStatus = { pending: 0, approved: 0, rejected: 0, cancelled: 0 };
    rows.forEach((row) => {
      if (row._id in byStatus) byStatus[row._id] = row.count;
    });

    res.json({
      success: true,
      ...byStatus,
      total: Object.values(byStatus).reduce((a, b) => a + b, 0),
    });
  } catch (error) {
    console.error("WFH stats error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to load work from home statistics",
      error: error.message,
    });
  }
});

/**
 * GET /api/work-from-home/policy
 * The rules a request is judged against. The form reads this rather than
 * hard-coding a window that could drift from the server's.
 */
router.get("/policy", authenticateToken, async (req, res) => {
  try {
    const policy = await wfhPolicyService.getPolicy(req.user.company._id);
    res.json({ success: true, policy });
  } catch (error) {
    console.error("WFH policy error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to load the work from home policy",
      error: error.message,
    });
  }
});

/**
 * GET /api/work-from-home/schedule?startDate&endDate
 * The approved work-mode schedule for a range, as the work-mode service
 * resolves it. Admins get the company; an employee gets only themselves.
 *
 * This is the endpoint any future report or calendar reads - it hands back the
 * resolved schedule rather than raw requests, so callers never re-derive the
 * precedence rule.
 */
router.get("/schedule", authenticateToken, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    if (!startDate || !endDate) {
      return res.status(400).json({
        success: false,
        message: "startDate and endDate are required",
      });
    }

    const schedule = await workModeService.getSchedule({
      companyId: req.user.company._id,
      startDate: String(startDate).slice(0, 10),
      endDate: String(endDate).slice(0, 10),
      employeeIds:
        req.user.role === "admin" ? null : [req.user._id],
    });

    res.json({
      success: true,
      dateRange: { startDate, endDate },
      schedule,
      workModes: workModeService.WORK_MODES,
    });
  } catch (error) {
    console.error("WFH schedule error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to load the work mode schedule",
      error: error.message,
    });
  }
});

// ---------------------------------------------------------------- Review

/**
 * PUT /api/work-from-home/:id/review
 * Admin approves or rejects. Only a pending request can be reviewed, so two
 * admins acting at once cannot overwrite each other's decision.
 */
router.put(
  "/:id/review",
  authenticateToken,
  authorizeRoles("admin"),
  async (req, res) => {
    try {
      const { status, reviewComments } = req.body;

      if (!["approved", "rejected"].includes(status)) {
        return res.status(400).json({
          success: false,
          message: "Status must be approved or rejected",
        });
      }

      const request = await WorkFromHome.findOneAndUpdate(
        {
          _id: req.params.id,
          company: req.user.company._id,
          status: "pending",
        },
        {
          status,
          reviewedBy: req.user._id,
          reviewedDate: new Date(),
          reviewComments: reviewComments || "",
        },
        { new: true }
      )
        .populate("employee", "name employeeId department email profilePicture")
        .populate("reviewedBy", "name");

      if (!request) {
        return res.status(404).json({
          success: false,
          message: "Request not found or already reviewed",
        });
      }

      // Real-time: the employee sees the decision, and every admin's queue
      // stops showing a request that has already been decided.
      const payload = {
        _id: request._id,
        status,
        totalDays: request.totalDays,
        startDate: request.startDate,
        endDate: request.endDate,
      };
      SocketService.toUser(
        request.employee._id || request.employee,
        SocketService.events.WFH_REVIEWED,
        payload
      );
      SocketService.toCompanyAdmins(
        request.company,
        SocketService.events.WFH_REVIEWED,
        payload
      );
      // An approved day changes what attendance reports for it.
      SocketService.statsUpdate(request.company, "wfh");

      // An approved day proves the person was working, so any leave the
      // unreported-absence rule charged for it is returned. Only leave that
      // rule created is touched.
      let reversedLeave = null;
      if (status === "approved") {
        try {
          const result = await unreportedAbsenceService.revokeAutoMarkedLeave({
            employeeId: request.employee._id || request.employee,
            companyId: request.company,
            startDate: request.startDate,
            endDate: request.endDate,
          });
          if (result.removed) reversedLeave = result;
        } catch (error) {
          console.error(
            `Could not reverse auto-marked leave for ${request._id}:`,
            error.message
          );
        }
      }

      let notificationFailed = false;
      try {
        if (status === "approved") {
          await notifyWfhApproval(request, request.employee);
        } else {
          await notifyWfhRejection(request, request.employee, reviewComments);
        }
      } catch (error) {
        console.error(
          `WFH decision notification failed for ${request._id}:`,
          error.message
        );
        notificationFailed = true;
      }

      res.json({
        success: true,
        message: `Work from home request ${status}${
          reversedLeave
            ? `. ${reversedLeave.days} automatically recorded leave day(s) were returned`
            : ""
        }${
          notificationFailed
            ? ", but the notification to the employee may have failed"
            : ""
        }`,
        request: serialize(request),
        reversedLeave,
      });
    } catch (error) {
      console.error("WFH review error:", error);
      res.status(500).json({
        success: false,
        message: "Failed to review the work from home request",
        error: error.message,
      });
    }
  }
);

/**
 * PUT /api/work-from-home/:id/cancel
 * The employee withdraws their own request while it is still pending.
 * Kept separate from a delete so the record, and its history, survives.
 */
router.put("/:id/cancel", authenticateToken, async (req, res) => {
  try {
    const request = await WorkFromHome.findOneAndUpdate(
      {
        _id: req.params.id,
        employee: req.user._id,
        status: "pending",
      },
      { status: "cancelled" },
      { new: true }
    ).populate("employee", "name employeeId department");

    if (!request) {
      return res.status(404).json({
        success: false,
        message: "Request not found, already reviewed, or not yours to cancel",
      });
    }

    SocketService.toCompanyAdmins(
      request.company,
      SocketService.events.WFH_REVIEWED,
      { _id: request._id, status: "cancelled" }
    );
    SocketService.statsUpdate(request.company, "wfh");

    res.json({
      success: true,
      message: "Work from home request cancelled",
      request: serialize(request),
    });
  } catch (error) {
    console.error("WFH cancel error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to cancel the work from home request",
      error: error.message,
    });
  }
});

/**
 * GET /api/work-from-home/:id
 * Declared last so it cannot shadow /stats or /schedule.
 */
router.get("/:id", authenticateToken, async (req, res) => {
  try {
    const query = { _id: req.params.id, company: req.user.company._id };
    if (req.user.role !== "admin") query.employee = req.user._id;

    const request = await WorkFromHome.findOne(query)
      .populate("employee", "name employeeId department profilePicture email")
      .populate("reviewedBy", "name")
      .lean();

    if (!request) {
      return res
        .status(404)
        .json({ success: false, message: "Request not found" });
    }

    res.json({ success: true, request });
  } catch (error) {
    console.error("WFH fetch error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to load the work from home request",
      error: error.message,
    });
  }
});

module.exports = router;
