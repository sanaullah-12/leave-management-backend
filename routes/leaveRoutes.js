const express = require("express");
const router = express.Router();
const { authMiddleware } = require("../middleware/authMiddleware");
const {
  getLeaveBalance,
  getLeavePolicy,
} = require("../controllers/leaveController");

// Leave policy route - MUST be before any :id routes
router.get("/policy", authMiddleware, getLeavePolicy);

// Get leave balance for a user
router.get("/balance/:userId", authMiddleware, getLeaveBalance);

module.exports = router;
