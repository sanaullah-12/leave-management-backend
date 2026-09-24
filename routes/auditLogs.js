/**
 * Security audit trail - read-only.
 *
 * Admins see their own company's entries only. There is no write, update or
 * delete endpoint: entries are created by services/auditLog.js and the model
 * itself refuses modification.
 */
const express = require("express");
const { authenticateToken, authorizeRoles } = require("../middleware/auth");
const { validate, z } = require("../middleware/validate");
const AuditLog = require("../models/AuditLog");
const { verifyChain } = require("../services/auditLog");

const router = express.Router();

router.use(authenticateToken, authorizeRoles("admin"));

const listQuery = z.object({
  page: z.string().regex(/^\d{1,6}$/).optional(),
  limit: z.string().regex(/^\d{1,3}$/).optional(),
  action: z.string().regex(/^[a-z_.]{1,64}$/).optional(),
  outcome: z.enum(["success", "failure", "denied"]).optional(),
});

router.get("/", validate({ query: listQuery }), async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const filter = { company: req.user.company._id };
    if (req.query.action) filter.action = req.query.action;
    if (req.query.outcome) filter.outcome = req.query.outcome;

    const [entries, total] = await Promise.all([
      AuditLog.find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate("actor", "name employeeId role")
        .select("-prevHash -hash")
        .lean(),
      AuditLog.countDocuments(filter),
    ]);

    res.json({
      entries,
      pagination: { current: page, pages: Math.ceil(total / limit), total },
    });
  } catch (error) {
    console.error("Audit log list error:", error.message);
    res.status(500).json({ message: "Failed to load audit log" });
  }
});

router.get("/verify", async (req, res) => {
  try {
    res.json(await verifyChain(req.user.company._id));
  } catch (error) {
    console.error("Audit chain verification error:", error.message);
    res.status(500).json({ message: "Failed to verify audit log" });
  }
});

module.exports = router;
