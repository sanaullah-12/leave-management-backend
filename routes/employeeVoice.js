const express = require("express");
const {
  authenticateToken,
  authorizeRoles,
} = require("../middleware/auth");
const {
  uploadVoiceAttachments,
  mapUploadedFiles,
  resolveAttachmentPath,
} = require("../middleware/voiceUpload");
const { validate, z, schemas } = require("../middleware/validate");
const { submissionLimiter } = require("../middleware/rateLimits");
const audit = require("../services/auditLog");
const EmployeeVoice = require("../models/EmployeeVoice");
const User = require("../models/User");
const {
  notifyVoiceSubmission,
  notifyVoiceReply,
  notifyVoiceStatus,
} = require("../utils/notifications");
const SocketService = require("../socket/socketService");

const router = express.Router();

const VALID_CATEGORIES = [
  "workplace_issue",
  "complaint",
  "suggestion",
  "hr_support",
  "appreciation",
  "feedback",
];
const VALID_PRIORITIES = ["low", "medium", "high", "urgent"];
const VALID_STATUSES = [
  "pending",
  "under_review",
  "in_progress",
  "waiting_employee",
  "resolved",
  "closed",
];
const CLOSED_STATUSES = ["resolved", "closed"];
const STATUS_LABELS = {
  pending: "Pending",
  under_review: "Under Review",
  in_progress: "In Progress",
  waiting_employee: "Waiting for Employee",
  resolved: "Resolved",
  closed: "Closed",
};

// Hide the submitter's identity from anyone who is not the owner when a
// submission is anonymous (admins see "Anonymous", the owner sees themselves).
const serializeVoice = (voiceDoc, viewer) => {
  const v = voiceDoc.toObject ? voiceDoc.toObject() : voiceDoc;
  const ownerId = (v.employee && (v.employee._id || v.employee))?.toString();
  const isOwner = ownerId && viewer && ownerId === viewer._id.toString();

  // Attachments are served only through the authenticated download route;
  // the on-disk name is never exposed.
  v.attachments = (v.attachments || []).map((a, index) => ({
    _id: a._id,
    originalName: a.originalName,
    mimetype: a.mimetype,
    size: a.size,
    path: `/api/employee-voice/${v._id}/attachments/${index}`,
  }));

  if (v.isAnonymous && !isOwner) {
    v.employee = { name: "Anonymous", anonymous: true };
    v.replies = (v.replies || []).map((r) =>
      r.authorRole === "employee"
        ? { ...r, author: undefined, authorName: "Anonymous" }
        : r
    );
  }
  return v;
};

/* ------------------------------------------------------------------ */
/*  Create a new Employee Voice (any authenticated user)              */
/* ------------------------------------------------------------------ */
router.post("/", authenticateToken, submissionLimiter, uploadVoiceAttachments, async (req, res) => {
  try {
    const { category, title, description, priority } = req.body;
    const isAnonymous =
      req.body.isAnonymous === true || req.body.isAnonymous === "true";
    const department =
      typeof req.body.department === "string" && req.body.department.trim()
        ? req.body.department.trim().slice(0, 100)
        : req.user.department;

    if (typeof title !== "string" || typeof description !== "string") {
      return res.status(400).json({ message: "Title and description are required" });
    }
    // Validation (manual - matches the codebase convention).
    if (!category || !VALID_CATEGORIES.includes(category)) {
      return res.status(400).json({ message: "Please select a valid category" });
    }
    if (!title || !title.trim()) {
      return res.status(400).json({ message: "Title is required" });
    }
    if (!description || !description.trim()) {
      return res.status(400).json({ message: "Description is required" });
    }
    if (priority && !VALID_PRIORITIES.includes(priority)) {
      return res.status(400).json({ message: "Invalid priority" });
    }

    const voice = new EmployeeVoice({
      employee: req.user._id,
      company: req.user.company._id,
      category,
      title: title.trim(),
      description: description.trim(),
      priority: priority || "medium",
      department,
      isAnonymous,
      attachments: mapUploadedFiles(req.voiceAttachments),
    });

    await voice.save();
    await voice.populate(
      "employee",
      "name employeeId department position profilePicture"
    );

    // Real-time: admins' Employee Voice widget, dashboard count and sidebar
    // badge update instantly (per-admin notification is pushed below too).
    SocketService.toCompanyAdmins(voice.company, SocketService.events.VOICE_NEW, {
      _id: voice._id,
      category: voice.category,
      title: voice.title,
      isAnonymous: voice.isAnonymous,
    });
    SocketService.statsUpdate(voice.company, "voice");

    // Respond immediately, then notify admins in the background (non-blocking).
    res.status(201).json({
      message: "Your voice has been submitted successfully",
      voice: serializeVoice(voice, req.user),
      success: true,
    });

    setImmediate(async () => {
      try {
        const admins = await User.find({
          company: req.user.company._id,
          role: "admin",
          status: "active",
        });
        await Promise.allSettled(
          admins.map((admin) => notifyVoiceSubmission(voice, admin))
        );
      } catch (err) {
        console.error("Voice submission notification error:", err.message);
      }
    });
  } catch (error) {
    console.error("Employee voice submission error:", error);
    res.status(500).json({
      message: "Failed to submit your voice",
      error: error.message,
    });
  }
});

/* ------------------------------------------------------------------ */
/*  List voices (employees see their own, admins see the whole company) */
/* ------------------------------------------------------------------ */
router.get("/", authenticateToken, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const skip = (page - 1) * limit;
    const { status, category, priority } = req.query;

    const query = { company: req.user.company._id };
    if (req.user.role === "employee") {
      query.employee = req.user._id;
    }
    if (status && VALID_STATUSES.includes(status)) query.status = status;
    if (category && VALID_CATEGORIES.includes(category)) query.category = category;
    if (priority && VALID_PRIORITIES.includes(priority)) query.priority = priority;

    const voices = await EmployeeVoice.find(query)
      .populate("employee", "name employeeId department position profilePicture")
      .populate("reviewedBy", "name")
      .skip(skip)
      .limit(limit)
      .sort({ createdAt: -1 });

    const total = await EmployeeVoice.countDocuments(query);

    res.status(200).json({
      voices: voices.map((v) => serializeVoice(v, req.user)),
      pagination: {
        current: page,
        pages: Math.ceil(total / limit),
        total,
      },
    });
  } catch (error) {
    res.status(500).json({
      message: "Failed to load employee voices",
      error: error.message,
    });
  }
});

/* ------------------------------------------------------------------ */
/*  Current user's own voices                                          */
/* ------------------------------------------------------------------ */
router.get("/my-voices", authenticateToken, async (req, res) => {
  try {
    const voices = await EmployeeVoice.find({ employee: req.user._id })
      .populate("employee", "name employeeId department profilePicture")
      .populate("reviewedBy", "name")
      .sort({ createdAt: -1 });

    res.status(200).json({
      success: true,
      count: voices.length,
      voices: voices.map((v) => serializeVoice(v, req.user)),
    });
  } catch (error) {
    res.status(500).json({
      message: "Failed to load your voices",
      error: error.message,
    });
  }
});

/* ------------------------------------------------------------------ */
/*  Dashboard statistics (Admin only)                                  */
/* ------------------------------------------------------------------ */
router.get(
  "/stats/dashboard",
  authenticateToken,
  authorizeRoles("admin"),
  async (req, res) => {
    try {
      const companyId = req.user.company._id;
      const startOfToday = new Date();
      startOfToday.setHours(0, 0, 0, 0);

      const [pending, resolved, newToday, highPriority, total, byStatusAgg, byCategoryAgg] =
        await Promise.all([
          EmployeeVoice.countDocuments({
            company: companyId,
            status: { $nin: CLOSED_STATUSES },
          }),
          EmployeeVoice.countDocuments({
            company: companyId,
            status: { $in: CLOSED_STATUSES },
          }),
          EmployeeVoice.countDocuments({
            company: companyId,
            createdAt: { $gte: startOfToday },
          }),
          EmployeeVoice.countDocuments({
            company: companyId,
            priority: { $in: ["high", "urgent"] },
            status: { $nin: CLOSED_STATUSES },
          }),
          EmployeeVoice.countDocuments({ company: companyId }),
          EmployeeVoice.aggregate([
            { $match: { company: companyId } },
            { $group: { _id: "$status", count: { $sum: 1 } } },
          ]),
          EmployeeVoice.aggregate([
            { $match: { company: companyId } },
            { $group: { _id: "$category", count: { $sum: 1 } } },
          ]),
        ]);

      res.status(200).json({
        pending,
        resolved,
        newToday,
        highPriority,
        total,
        byStatus: byStatusAgg,
        byCategory: byCategoryAgg,
      });
    } catch (error) {
      console.error("Voice stats error:", error);
      res.status(500).json({
        message: "Failed to get employee voice statistics",
        error: error.message,
      });
    }
  }
);

/* ------------------------------------------------------------------ */
/*  Attachment download (owner or admin, company-scoped)               */
/* ------------------------------------------------------------------ */
router.get(
  "/:id/attachments/:index",
  authenticateToken,
  validate({
    params: z.object({
      id: schemas.objectId,
      index: z.string().regex(/^\d{1,2}$/).transform(Number),
    }),
  }),
  async (req, res) => {
    try {
      const query = { _id: req.params.id, company: req.user.company._id };
      if (req.user.role === "employee") query.employee = req.user._id;

      const voice = await EmployeeVoice.findOne(query).select("attachments employee isAnonymous");
      const attachment = voice && voice.attachments[req.params.index];
      const filePath = attachment && resolveAttachmentPath(attachment.filename);
      if (!filePath) {
        return res.status(404).json({ message: "Attachment not found" });
      }

      audit.record({
        req,
        action: "voice.attachment.download",
        targetType: "employee_voice",
        targetId: voice._id,
        metadata: { index: req.params.index },
      });

      // Always a download, never rendered by the browser in the API's origin.
      const safeType = ["image/png", "image/jpeg", "image/webp", "image/gif", "application/pdf"]
        .includes(attachment.mimetype)
        ? attachment.mimetype
        : "application/octet-stream";
      res.setHeader("Content-Type", safeType);
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
      res.setHeader("Cache-Control", "private, no-store");
      res.attachment(attachment.originalName || `attachment-${req.params.index}`);
      res.sendFile(filePath);
    } catch (error) {
      console.error("Voice attachment download error:", error.message);
      res.status(500).json({ message: "Failed to load attachment" });
    }
  }
);

/* ------------------------------------------------------------------ */
/*  Single voice (owner or admin, company-scoped)                      */
/* ------------------------------------------------------------------ */
router.get("/:id", authenticateToken, validate({ params: z.object({ id: schemas.objectId }) }), async (req, res) => {
  try {
    const query = { _id: req.params.id, company: req.user.company._id };
    if (req.user.role === "employee") query.employee = req.user._id;

    const voice = await EmployeeVoice.findOne(query)
      .populate("employee", "name employeeId department position profilePicture")
      .populate("reviewedBy", "name")
      .populate("replies.author", "name profilePicture role");

    if (!voice) {
      return res.status(404).json({ message: "Voice not found" });
    }

    res.status(200).json({ voice: serializeVoice(voice, req.user) });
  } catch (error) {
    res.status(500).json({
      message: "Failed to load voice",
      error: error.message,
    });
  }
});

/* ------------------------------------------------------------------ */
/*  Post a reply (owner or admin)                                      */
/* ------------------------------------------------------------------ */
router.post("/:id/reply", authenticateToken, submissionLimiter, validate({ params: z.object({ id: schemas.objectId }) }), async (req, res) => {
  try {
    const { message } = req.body;
    if (typeof message !== "string" || !message.trim()) {
      return res.status(400).json({ message: "Reply message is required" });
    }

    const query = { _id: req.params.id, company: req.user.company._id };
    if (req.user.role === "employee") query.employee = req.user._id;

    const voice = await EmployeeVoice.findOne(query);
    if (!voice) {
      return res.status(404).json({ message: "Voice not found" });
    }

    voice.replies.push({
      author: req.user._id,
      authorName: req.user.name,
      authorRole: req.user.role,
      message: message.trim(),
    });

    // An admin reply that lands on a brand-new item moves it into review.
    if (req.user.role === "admin" && voice.status === "pending") {
      voice.status = "under_review";
      voice.reviewedBy = req.user._id;
      voice.reviewedDate = new Date();
    }

    await voice.save();
    await voice.populate(
      "employee",
      "name employeeId department position profilePicture"
    );
    await voice.populate("replies.author", "name profilePicture role");

    // Real-time: both sides of the thread refresh. A reply can also flip the
    // status (pending -> under_review), so admins need the signal too - their
    // list, open drawer and counters would otherwise sit stale until a refocus.
    const replyPayload = { _id: voice._id, status: voice.status };
    SocketService.toUser(
      voice.employee._id || voice.employee,
      SocketService.events.VOICE_UPDATED,
      replyPayload
    );
    SocketService.toCompanyAdmins(
      voice.company,
      SocketService.events.VOICE_UPDATED,
      replyPayload
    );
    SocketService.statsUpdate(voice.company, "voice");

    // Notify the other party.
    setImmediate(async () => {
      try {
        if (req.user.role === "admin") {
          await notifyVoiceReply(voice, voice.employee._id || voice.employee, req.user);
        } else {
          const admins = await User.find({
            company: req.user.company._id,
            role: "admin",
            status: "active",
          });
          await Promise.allSettled(
            admins.map((admin) => notifyVoiceReply(voice, admin._id, req.user))
          );
        }
      } catch (err) {
        console.error("Voice reply notification error:", err.message);
      }
    });

    res.status(200).json({
      message: "Reply posted",
      voice: serializeVoice(voice, req.user),
    });
  } catch (error) {
    res.status(500).json({
      message: "Failed to post reply",
      error: error.message,
    });
  }
});

/* ------------------------------------------------------------------ */
/*  Update status (Admin only)                                         */
/* ------------------------------------------------------------------ */
router.put(
  "/:id/status",
  authenticateToken,
  authorizeRoles("admin"),
  validate({ params: z.object({ id: schemas.objectId }) }),
  async (req, res) => {
    try {
      const { status } = req.body;
      if (!VALID_STATUSES.includes(status)) {
        return res.status(400).json({ message: "Invalid status" });
      }

      const update = {
        status,
        reviewedBy: req.user._id,
        reviewedDate: new Date(),
      };
      if (CLOSED_STATUSES.includes(status)) {
        update.resolvedDate = new Date();
      }

      const voice = await EmployeeVoice.findOneAndUpdate(
        { _id: req.params.id, company: req.user.company._id },
        update,
        { new: true }
      )
        .populate("employee", "name employeeId department position profilePicture")
        .populate("reviewedBy", "name")
        .populate("replies.author", "name profilePicture role");

      if (!voice) {
        return res.status(404).json({ message: "Voice not found" });
      }

      // Real-time: the submitting employee sees the status change instantly,
      // and every admin (including the actor's other tabs) refreshes the list,
      // the status filter counts and the stat chips.
      audit.record({
        req,
        action: "voice.status.update",
        targetType: "employee_voice",
        targetId: voice._id,
        metadata: { status },
      });

      const statusPayload = { _id: voice._id, status: voice.status };
      SocketService.toUser(
        voice.employee._id || voice.employee,
        SocketService.events.VOICE_UPDATED,
        statusPayload
      );
      SocketService.toCompanyAdmins(
        voice.company,
        SocketService.events.VOICE_UPDATED,
        statusPayload
      );
      SocketService.statsUpdate(voice.company, "voice");

      setImmediate(async () => {
        try {
          await notifyVoiceStatus(voice, STATUS_LABELS[status], req.user);
        } catch (err) {
          console.error("Voice status notification error:", err.message);
        }
      });

      res.status(200).json({
        message: `Status updated to ${STATUS_LABELS[status]}`,
        voice: serializeVoice(voice, req.user),
      });
    } catch (error) {
      res.status(500).json({
        message: "Failed to update status",
        error: error.message,
      });
    }
  }
);

/* ------------------------------------------------------------------ */
/*  Delete (Admin only)                                                */
/* ------------------------------------------------------------------ */
router.delete(
  "/:id",
  authenticateToken,
  authorizeRoles("admin"),
  validate({ params: z.object({ id: schemas.objectId }) }),
  async (req, res) => {
    try {
      const voice = await EmployeeVoice.findOneAndDelete({
        _id: req.params.id,
        company: req.user.company._id,
      });
      if (!voice) {
        return res.status(404).json({ message: "Voice not found" });
      }

      // Real-time: drop the removed item from every other client's list and
      // counters instead of leaving a ghost row behind.
      audit.record({
        req,
        action: "voice.delete",
        targetType: "employee_voice",
        targetId: voice._id,
      });

      // The attachments go with the record.
      const fs = require("fs");
      (voice.attachments || []).forEach((a) => {
        const filePath = resolveAttachmentPath(a.filename);
        if (filePath) fs.promises.unlink(filePath).catch(() => {});
      });

      const deletedPayload = { _id: voice._id, deleted: true };
      SocketService.toUser(
        voice.employee._id || voice.employee,
        SocketService.events.VOICE_UPDATED,
        deletedPayload
      );
      SocketService.toCompanyAdmins(
        voice.company,
        SocketService.events.VOICE_UPDATED,
        deletedPayload
      );
      SocketService.statsUpdate(voice.company, "voice");

      res.status(200).json({ message: "Voice deleted successfully" });
    } catch (error) {
      res.status(500).json({
        message: "Failed to delete voice",
        error: error.message,
      });
    }
  }
);

module.exports = router;
