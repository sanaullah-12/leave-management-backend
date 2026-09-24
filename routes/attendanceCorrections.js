const express = require("express");
const { authenticateToken, authorizeRoles } = require("../middleware/auth");
const { requireDeviceTenant } = require("../middleware/deviceAccess");
const { validate, z, schemas } = require("../middleware/validate");
const AttendanceCorrection = require("../models/AttendanceCorrection");
const User = require("../models/User");
const AttendanceDbService = require("../services/attendanceDbService");
const lateHoursService = require("../services/lateHoursService");
const attendanceCorrectionService = require("../services/attendanceCorrectionService");
const { arrivalMinutes } = require("../utils/lateness");
const { displayDate, displayTime, today: officeToday } = require("../utils/timezone");
const SocketService = require("../socket/socketService");
const { NotificationService, NOTIFICATION_EVENTS } = require("../notifications");
const audit = require("../services/auditLog");

/**
 * Time change requests.
 *
 * An employee who arrived late with the office's knowledge asks for that day's
 * arrival to be read at an agreed time; an admin approves or rejects it.
 *
 * Who may do what:
 *   - raising a request is only ever about the caller's own attendance. The
 *     employee code comes from the signed-in account, never from the body, so
 *     there is no field to point at someone else;
 *   - only an admin of the same company reviews, and never their own request
 *     while another admin exists to do it;
 *   - only the requester withdraws, and only while it is pending.
 *
 * Approving writes nothing to the attendance log. The approved request itself
 * is what every attendance read consults, through
 * services/attendanceCorrectionService, so the new arrival applies everywhere
 * at once and the device punch stays exactly as it was recorded.
 */
const router = express.Router();

router.use(authenticateToken, requireDeviceTenant);

/** How far back a day can still be corrected. Older days are settled. */
const MAX_AGE_DAYS = 60;

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const createSchema = z
  .object({
    date: z.string().trim().regex(DAY, "must be YYYY-MM-DD"),
    requestedTime: z.string().trim().regex(HHMM, "must be HH:MM"),
    reason: z
      .string()
      .trim()
      .min(3, "is required")
      .max(500, "must be at most 500 characters"),
  })
  .strict();

const reviewSchema = z
  .object({
    status: z.enum(["approved", "rejected"]),
    reviewComments: z.string().trim().max(500).optional().default(""),
  })
  .strict();

const listSchema = z
  .object({
    status: z
      .enum(["pending", "approved", "rejected", "cancelled", "all"])
      .optional()
      .default("all"),
    limit: z.coerce.number().int().min(1).max(200).optional().default(100),
  })
  .strict();

const idParams = z.object({ id: schemas.objectId }).strict();

const shiftDay = (isoDate, delta) => {
  const day = new Date(`${isoDate}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() + delta);
  return day.toISOString().split("T")[0];
};

/** "09:05" as "9:05 AM". The requested time is minute-precise, so no seconds. */
const clockLabel = (hhmm) => {
  const [hour, minute] = String(hhmm).split(":").map(Number);
  const suffix = hour >= 12 ? "PM" : "AM";
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${hour12}:${String(minute).padStart(2, "0")} ${suffix}`;
};

/** The shape both the employee's and the admin's lists read. */
const serialize = (doc) => {
  const employee = doc.employee && doc.employee._id ? doc.employee : null;
  const reviewer = doc.reviewedBy && doc.reviewedBy._id ? doc.reviewedBy : null;
  return {
    id: String(doc._id),
    employee: employee
      ? {
          id: String(employee._id),
          name: employee.name,
          employeeId: employee.employeeId,
          department: employee.department || null,
          profilePicture: employee.profilePicture || null,
        }
      : null,
    employeeCode: doc.employeeCode,
    date: doc.date,
    dateDisplay: displayDate(new Date(`${doc.date}T12:00:00Z`)),
    machineCheckIn: doc.machineCheckIn,
    machineCheckInDisplay: displayTime(doc.machineCheckIn),
    requestedTime: doc.requestedTime,
    requestedCheckIn: doc.requestedCheckIn,
    requestedCheckInDisplay: clockLabel(doc.requestedTime),
    reason: doc.reason,
    judgedAgainst: doc.judgedAgainst || null,
    status: doc.status,
    reviewedBy: reviewer ? { id: String(reviewer._id), name: reviewer.name } : null,
    reviewedAt: doc.reviewedAt,
    reviewComments: doc.reviewComments || "",
    createdAt: doc.createdAt,
  };
};

const populateRequest = (query) =>
  query
    .populate("employee", "name employeeId department profilePicture")
    .populate("reviewedBy", "name");

/**
 * POST /api/attendance-corrections
 * The caller asks for one of their own late days to be read at another time.
 */
router.post("/", validate({ body: createSchema }), async (req, res) => {
  try {
    const { date, requestedTime, reason } = req.body;
    const code = req.user.employeeId ? String(req.user.employeeId) : null;

    if (!code) {
      return res.status(400).json({
        message: "No device ID is linked to your account, so there is no attendance to correct.",
      });
    }

    const todayIso = officeToday();
    if (date > todayIso) {
      return res.status(400).json({ message: "A time change can only be requested for a day that has passed or today." });
    }
    if (date < shiftDay(todayIso, -MAX_AGE_DAYS)) {
      return res.status(400).json({
        message: `Time changes can only be requested for the last ${MAX_AGE_DAYS} days.`,
      });
    }
    if (lateHoursService.isWeekend(date)) {
      return res.status(400).json({ message: "Weekends are not judged for lateness." });
    }

    // The machine arrival is read here, never taken from the request, so the
    // record of what the device saw cannot be supplied by the person it judges.
    const logs = await AttendanceDbService.fetchNormalizedLogs({
      employeeIds: [code],
      startDate: date,
      endDate: date,
    });
    const machineCheckIn = logs.reduce(
      (earliest, log) => (!earliest || log.timestamp < earliest ? log.timestamp : earliest),
      null
    );
    if (!machineCheckIn) {
      return res.status(400).json({ message: "No machine check-in was recorded for this day." });
    }

    // Judged against the saved office rule, not a preview of the other one.
    const base = await lateHoursService.resolveBasePolicy();
    const verdict = lateHoursService.judgeDay(
      machineCheckIn,
      lateHoursService.resolveDayPolicy({ date, base })
    );
    if (!verdict.isLate) {
      return res.status(400).json({ message: "This day is not marked late, so there is nothing to correct." });
    }

    const requestedCheckIn = attendanceCorrectionService.instantFor(date, requestedTime);
    if (arrivalMinutes(requestedCheckIn) >= arrivalMinutes(machineCheckIn)) {
      return res.status(400).json({
        message: `The requested time must be earlier than the machine check-in at ${displayTime(machineCheckIn)}.`,
      });
    }

    const existing = await AttendanceCorrection.findOne({
      company: req.user.company._id,
      employeeCode: code,
      date,
      active: true,
    })
      .select("status")
      .lean();
    if (existing) {
      return res.status(409).json({
        message:
          existing.status === "approved"
            ? "A time change for this day has already been approved."
            : "You already have a pending time change request for this day.",
      });
    }

    let request;
    try {
      request = await AttendanceCorrection.create({
        company: req.user.company._id,
        employee: req.user._id,
        employeeCode: code,
        date,
        machineCheckIn,
        requestedTime,
        requestedCheckIn,
        reason,
        judgedAgainst: {
          cutoffTime: verdict.effectiveCutoff,
          lateMinutes: verdict.lateMinutes,
        },
      });
    } catch (error) {
      // Two submissions racing past the check above; the index keeps one.
      if (error && error.code === 11000) {
        return res.status(409).json({ message: "You already have a pending time change request for this day." });
      }
      throw error;
    }

    audit.record({
      req,
      action: "attendance.time_change.request",
      targetType: "attendance_correction",
      targetId: request._id,
      metadata: {
        employeeCode: code,
        date,
        machineCheckIn,
        requestedTime,
      },
    });

    NotificationService.dispatch({
      event: NOTIFICATION_EVENTS.ATTENDANCE_TIME_CHANGE_REQUESTED,
      companyId: req.user.company._id,
      senderId: req.user._id,
      excludeUserId: req.user._id,
      dedupeKey: (recipient) => `time-change:${request._id}:requested:${recipient._id}`,
      payload: {
        employeeName: req.user.name,
        date,
        machineTime: displayTime(machineCheckIn),
        requestedTime: clockLabel(requestedTime),
        reason,
      },
    }).catch((error) => console.error("Time change request notification failed:", error.message));

    SocketService.statsUpdate(req.user.company._id, "time-change");

    const saved = await populateRequest(AttendanceCorrection.findById(request._id)).lean();
    res.status(201).json({
      success: true,
      message: "Time change request submitted",
      request: serialize(saved),
    });
  } catch (error) {
    console.error("Time change request failed:", error);
    res.status(500).json({ message: "Failed to submit the time change request" });
  }
});

/**
 * GET /api/attendance-corrections/mine
 * The caller's own requests, newest first.
 */
router.get("/mine", validate({ query: listSchema }), async (req, res) => {
  try {
    const { status, limit } = req.query;
    const query = { company: req.user.company._id, employee: req.user._id };
    if (status !== "all") query.status = status;

    const docs = await populateRequest(
      AttendanceCorrection.find(query).sort({ createdAt: -1 }).limit(limit)
    ).lean();

    res.json({ success: true, requests: docs.map(serialize) });
  } catch (error) {
    console.error("Own time change list failed:", error);
    res.status(500).json({ message: "Failed to load your time change requests" });
  }
});

/**
 * GET /api/attendance-corrections
 * The company's requests for review, with a count per status.
 */
router.get("/", authorizeRoles("admin"), validate({ query: listSchema }), async (req, res) => {
  try {
    const { status, limit } = req.query;
    const companyId = req.user.company._id;
    const query = { company: companyId };
    if (status !== "all") query.status = status;

    const [docs, grouped] = await Promise.all([
      populateRequest(
        AttendanceCorrection.find(query)
          // Oldest pending first is the order a queue is worked in; decided
          // requests read newest first.
          .sort(status === "pending" ? { createdAt: 1 } : { createdAt: -1 })
          .limit(limit)
      ).lean(),
      AttendanceCorrection.aggregate([
        { $match: { company: companyId } },
        { $group: { _id: "$status", count: { $sum: 1 } } },
      ]),
    ]);

    const counts = { pending: 0, approved: 0, rejected: 0, cancelled: 0 };
    for (const row of grouped) counts[row._id] = row.count;

    res.json({ success: true, requests: docs.map(serialize), counts });
  } catch (error) {
    console.error("Time change list failed:", error);
    res.status(500).json({ message: "Failed to load time change requests" });
  }
});

/**
 * PUT /api/attendance-corrections/:id/review
 * An admin approves or rejects a pending request.
 */
router.put(
  "/:id/review",
  authorizeRoles("admin"),
  validate({ params: idParams, body: reviewSchema }),
  async (req, res) => {
    try {
      const { status, reviewComments } = req.body;
      const companyId = req.user.company._id;

      // Nobody approves their own request while another admin could.
      const ownRequest = await AttendanceCorrection.exists({
        _id: req.params.id,
        company: companyId,
        employee: req.user._id,
      });
      if (ownRequest) {
        const otherAdmins = await User.countDocuments({
          company: companyId,
          role: "admin",
          status: "active",
          isActive: true,
          _id: { $ne: req.user._id },
        });
        if (otherAdmins > 0) {
          return res.status(403).json({ message: "Your own request must be reviewed by another admin" });
        }
      }

      // Conditional on still being pending, so two admins deciding at once
      // cannot both win.
      const request = await populateRequest(
        AttendanceCorrection.findOneAndUpdate(
          { _id: req.params.id, company: companyId, status: "pending" },
          {
            status,
            active: status === "approved",
            reviewedBy: req.user._id,
            reviewedAt: new Date(),
            reviewComments,
          },
          { new: true }
        )
      );

      if (!request) {
        return res.status(404).json({ message: "Request not found or already reviewed" });
      }

      audit.record({
        req,
        action: `attendance.time_change.${status === "approved" ? "approve" : "reject"}`,
        targetType: "attendance_correction",
        targetId: request._id,
        metadata: {
          employeeCode: request.employeeCode,
          date: request.date,
          // Both instants, so the trail alone says what the device recorded
          // and what the day is now judged by.
          machineCheckIn: request.machineCheckIn,
          requestedTime: request.requestedTime,
        },
      });

      // Every open attendance screen in the company refetches, which is what
      // makes an approval show up on dashboards and reports immediately. Only
      // an approval moves a verdict, so only it asks clients to drop cached
      // attendance.
      SocketService.statsUpdate(
        companyId,
        status === "approved" ? "time-change-approved" : "time-change"
      );

      NotificationService.dispatch({
        event:
          status === "approved"
            ? NOTIFICATION_EVENTS.ATTENDANCE_TIME_CHANGE_APPROVED
            : NOTIFICATION_EVENTS.ATTENDANCE_TIME_CHANGE_REJECTED,
        companyId,
        senderId: req.user._id,
        userId: request.employee._id,
        dedupeKey: `time-change:${request._id}:${status}`,
        payload: {
          date: request.date,
          requestedTime: clockLabel(request.requestedTime),
          reviewComments,
        },
      }).catch((error) => console.error("Time change decision notification failed:", error.message));

      res.json({
        success: true,
        message: `Time change request ${status}`,
        request: serialize(request.toObject()),
      });
    } catch (error) {
      console.error("Time change review failed:", error);
      res.status(500).json({ message: "Failed to review the time change request" });
    }
  }
);

/**
 * PUT /api/attendance-corrections/:id/cancel
 * The requester withdraws a request that has not been decided yet.
 */
router.put("/:id/cancel", validate({ params: idParams }), async (req, res) => {
  try {
    const request = await populateRequest(
      AttendanceCorrection.findOneAndUpdate(
        {
          _id: req.params.id,
          company: req.user.company._id,
          employee: req.user._id,
          status: "pending",
        },
        { status: "cancelled", active: false },
        { new: true }
      )
    );

    if (!request) {
      return res.status(404).json({ message: "Request not found or no longer pending" });
    }

    audit.record({
      req,
      action: "attendance.time_change.cancel",
      targetType: "attendance_correction",
      targetId: request._id,
      metadata: { employeeCode: request.employeeCode, date: request.date },
    });

    SocketService.statsUpdate(request.company, "time-change");

    res.json({
      success: true,
      message: "Time change request withdrawn",
      request: serialize(request.toObject()),
    });
  } catch (error) {
    console.error("Time change cancel failed:", error);
    res.status(500).json({ message: "Failed to withdraw the time change request" });
  }
});

module.exports = router;
