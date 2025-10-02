const express = require("express");
const { authenticateToken, authorizeRoles } = require("../middleware/auth");
const ZKTecoService = require("../services/zktecoService");

const router = express.Router();

// Simple working employees route
router.get(
  "/:ip",
  authenticateToken,
  authorizeRoles("admin"),
  async (req, res) => {
    try {
      const { ip } = req.params;
      console.log(`📋 Fetching employees from ZKTeco machine at ${ip}`);

      const zkService = new ZKTecoService(ip, 4370);

      await zkService.connect();
      const users = await zkService.getUsers();
      await zkService.disconnect();

    const formattedEmployees = users.map(user => ({
      machineId: user.uid || user.userId || user.id || 'unknown',
      name: user.name || 'Unknown Name',
      // FIXED: Use UserID for accurate attendance correlation
      employeeId: user.userId || user.rawData?.userid || user.uid || 'unknown',
      // Keep card number as separate reference
      cardNumber: user.cardno || user.cardNumber || null,
      department: user.role === 14 ? 'Admin' : user.role === 0 ? 'Employee' : `Role ${user.role}`,
      enrolledAt: user.timestamp || new Date(),
      isActive: user.role !== '0' && user.role !== 0,
      privilege: user.privilege || 0,
      role: user.role || 0,
      // Enhanced metadata for clarity
      idMapping: {
        uid: user.uid,
        userId: user.userId || user.rawData?.userid,
        cardno: user.cardno || user.cardNumber,
        source: 'ZKTeco_UserID_primary'
      },
      rawData: user
    }));      res.json({
        success: true,
        employees: formattedEmployees,
        count: formattedEmployees.length,
        machineIp: ip,
        fetchedAt: new Date(),
      });
    } catch (error) {
      console.error(`❌ Failed to fetch employees:`, error);
      res.status(500).json({
        success: false,
        message: `Failed to fetch employees: ${error.message}`,
        error: error.message,
      });
    }
  }
);

module.exports = router;
