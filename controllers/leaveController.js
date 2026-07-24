const db = require("../db"); // Adjust the path as necessary

// Default leave balances configuration - CORRECT VALUES
const DEFAULT_LEAVE_BALANCES = {
  casual: 10,
  sick: 8,
  annual: 10,
};

// Initialize and fix leave balances for a user
const initializeLeaveBalances = async (userId, year) => {
  const connection = await db.getConnection();
  try {
    for (const [leaveType, totalDays] of Object.entries(
      DEFAULT_LEAVE_BALANCES,
    )) {
      // Check if balance exists
      const [existing] = await connection.query(
        `SELECT id, total_days FROM leave_balances 
                 WHERE user_id = ? AND leave_type = ? AND year = ?`,
        [userId, leaveType, year],
      );

      if (existing.length === 0) {
        // Insert new balance
        await connection.query(
          `INSERT INTO leave_balances (user_id, leave_type, total_days, used_days, year) 
                     VALUES (?, ?, ?, 0, ?)`,
          [userId, leaveType, totalDays, year],
        );
      } else if (existing[0].total_days !== totalDays) {
        // Fix wrong total_days value
        await connection.query(
          `UPDATE leave_balances SET total_days = ? 
                     WHERE user_id = ? AND leave_type = ? AND year = ?`,
          [totalDays, userId, leaveType, year],
        );
      }
    }
  } finally {
    connection.release();
  }
};

// Get leave balance for a user
const getLeaveBalance = async (req, res) => {
  try {
    const userId = req.params.userId;
    const currentYear = new Date().getFullYear();

    // Initialize and fix balances
    await initializeLeaveBalances(userId, currentYear);

    const [balances] = await db.query(
      `SELECT leave_type, total_days, used_days, (total_days - used_days) as remaining_days 
             FROM leave_balances 
             WHERE user_id = ? AND year = ?`,
      [userId, currentYear],
    );

    res.json(balances);
  } catch (error) {
    res
      .status(500)
      .json({ message: "Failed to fetch leave balance", error: error.message });
  }
};

// Update leave status (Approve/Reject) - Modified to deduct balance
const updateLeaveStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, admin_remarks } = req.body;

    // Get leave request details first
    const [leaveRequest] = await db.query(
      "SELECT * FROM leave_requests WHERE id = ?",
      [id],
    );

    if (leaveRequest.length === 0) {
      return res.status(404).json({ message: "Leave request not found" });
    }

    const leave = leaveRequest[0];

    // Update leave request status
    await db.query(
      "UPDATE leave_requests SET status = ?, admin_remarks = ?, updated_at = NOW() WHERE id = ?",
      [status, admin_remarks || "", id],
    );

    // If approved, deduct from balance
    if (status === "approved") {
      const startDate = new Date(leave.start_date);
      const endDate = new Date(leave.end_date);
      const days = Math.ceil((endDate - startDate) / (1000 * 60 * 60 * 24)) + 1;
      const currentYear = new Date().getFullYear();

      // Initialize balance if not exists
      await initializeLeaveBalances(leave.user_id, currentYear);

      // Update used days
      await db.query(
        `UPDATE leave_balances 
                 SET used_days = used_days + ?, updated_at = NOW() 
                 WHERE user_id = ? AND leave_type = ? AND year = ?`,
        [days, leave.user_id, leave.leave_type, currentYear],
      );
    }

    res.json({ message: `Leave request ${status} successfully` });
  } catch (error) {
    res
      .status(500)
      .json({ message: "Failed to update leave status", error: error.message });
  }
};

// Get leave policy - Simple fix with correct values
const getLeavePolicy = (req, res) => {
  try {
    console.log("🟢 getLeavePolicy called");

    const policy = [
      { leave_type: "casual", total_days: 10, name: "Casual Leave" },
      { leave_type: "sick", total_days: 8, name: "Sick Leave" },
      { leave_type: "annual", total_days: 10, name: "Annual Leave" },
    ];

    console.log("🟢 Returning policy:", policy);
    return res.status(200).json(policy);
  } catch (error) {
    console.error("🔴 getLeavePolicy error:", error);
    return res
      .status(500)
      .json({ message: "Failed to fetch leave policy", error: error.message });
  }
};

module.exports = {
  getLeaveBalance,
  initializeLeaveBalances,
  updateLeaveStatus,
  getLeavePolicy,
};
