const express = require("express");
const { authenticateToken, authorizeRoles } = require("../middleware/auth");
const AttendanceSettings = require("../models/AttendanceSettings");
const Leave = require("../models/Leave");
const unreportedAbsenceService = require("../services/unreportedAbsenceService");
const { localDateString } = require("../utils/timezone");

/**
 * Unreported absence
 * ------------------
 * Admin control over the rule that turns an unexplained day into leave: read
 * and change the policy, preview what a run would do, and run it by hand.
 *
 * The scheduler applies the rule on its own; these routes exist so an admin can
 * see the rule's reasoning before trusting it, and re-run a day the server
 * missed.
 */

const router = express.Router();

/** GET /api/unreported-absence/policy */
router.get("/policy", authenticateToken, async (req, res) => {
  try {
    const policy = await unreportedAbsenceService.getPolicy();
    res.json({ success: true, policy });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to load the unreported absence policy",
      error: error.message,
    });
  }
});

/** PUT /api/unreported-absence/policy - admin only. */
router.put(
  "/policy",
  authenticateToken,
  authorizeRoles("admin"),
  async (req, res) => {
    try {
      const { enabled, cutoffTime, leaveType, fallbackLeaveType } = req.body;

      if (cutoffTime && !/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/.test(cutoffTime)) {
        return res.status(400).json({
          success: false,
          message: "Cutoff time must be in HH:MM format",
        });
      }

      const settings = await AttendanceSettings.getSettings();
      const current = settings.unreportedAbsenceSettings || {};

      settings.unreportedAbsenceSettings = {
        enabled: enabled ?? current.enabled ?? true,
        cutoffTime: cutoffTime || current.cutoffTime || "14:00",
        leaveType: leaveType || current.leaveType || "annual",
        fallbackLeaveType:
          fallbackLeaveType || current.fallbackLeaveType || "unpaid",
      };
      settings.updatedBy = req.user._id;
      if (!settings.createdBy) settings.createdBy = req.user._id;
      await settings.save();

      res.json({
        success: true,
        message: "Unreported absence policy updated",
        policy: await unreportedAbsenceService.getPolicy(),
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        message: "Failed to update the unreported absence policy",
        error: error.message,
      });
    }
  }
);

/**
 * GET /api/unreported-absence/preview?date=YYYY-MM-DD
 * Who the rule would charge, and who it would skip and why. Writes nothing.
 */
router.get(
  "/preview",
  authenticateToken,
  authorizeRoles("admin"),
  async (req, res) => {
    try {
      const report = await unreportedAbsenceService.markUnreportedAbsences({
        companyId: req.user.company._id,
        date: String(req.query.date || localDateString(new Date())).slice(0, 10),
        dryRun: true,
        force: req.query.force === "true",
      });
      res.json({ success: true, ...report });
    } catch (error) {
      res.status(500).json({
        success: false,
        message: "Failed to preview the unreported absence run",
        error: error.message,
      });
    }
  }
);

/**
 * POST /api/unreported-absence/run
 * Applies the rule for a day. `force` ignores the cutoff, for re-running a day
 * the server was down for.
 */
router.post(
  "/run",
  authenticateToken,
  authorizeRoles("admin"),
  async (req, res) => {
    try {
      const report = await unreportedAbsenceService.markUnreportedAbsences({
        companyId: req.user.company._id,
        date: String(req.body.date || localDateString(new Date())).slice(0, 10),
        force: req.body.force === true,
      });
      res.json({
        success: true,
        message: report.ran
          ? `${report.marked.length} day(s) recorded as leave`
          : `Nothing to do: ${report.reason}`,
        ...report,
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        message: "Failed to run the unreported absence rule",
        error: error.message,
      });
    }
  }
);

/**
 * GET /api/unreported-absence/records
 * The leave this rule has recorded. An employee sees their own.
 */
router.get("/records", authenticateToken, async (req, res) => {
  try {
    const query = {
      company: req.user.company._id,
      isAutoMarked: true,
    };
    if (req.user.role !== "admin") query.employee = req.user._id;

    const records = await Leave.find(query)
      .populate("employee", "name employeeId department")
      .sort({ startDate: -1 })
      .limit(Math.min(200, parseInt(req.query.limit, 10) || 50))
      .lean();

    res.json({ success: true, records, total: records.length });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to load automatically recorded leave",
      error: error.message,
    });
  }
});

module.exports = router;
