const express = require("express");
const { generateToken } = require("../utils/jwt");
const { authenticateToken } = require("../middleware/auth");
const { validatePhoneField } = require("../middleware/phoneValidation");
const { serializeAuthUser } = require("../utils/serializeUser");
const User = require("../models/User");
const Company = require("../models/Company");

const router = express.Router();

// Register company admin
router.post("/register-company", validatePhoneField("phone"), async (req, res) => {
  console.log("=== REGISTRATION REQUEST ===");
  console.log("Request body:", req.body);
  console.log("Headers:", req.headers);
  console.log("MongoDB status:", require("mongoose").connection.readyState);

  try {
    const {
      companyName,
      companyEmail,
      adminName,
      adminEmail,
      password,
      phone,
    } = req.body;

    // Validate required fields
    if (
      !companyName ||
      !companyEmail ||
      !adminName ||
      !adminEmail ||
      !password
    ) {
      console.log("Missing required fields");
      return res.status(400).json({
        message: "Missing required fields",
        required: [
          "companyName",
          "companyEmail",
          "adminName",
          "adminEmail",
          "password",
        ],
      });
    }

    // Check if company already exists
    const existingCompany = await Company.findOne({
      $or: [{ name: companyName }, { email: companyEmail }],
    });
    if (existingCompany) {
      return res.status(400).json({ message: "Company already exists" });
    }

    // Check if admin email already exists
    const existingUser = await User.findOne({ email: adminEmail });
    if (existingUser) {
      return res.status(400).json({ message: "Email already registered" });
    }

    // Create company
    const company = new Company({
      name: companyName,
      email: companyEmail,
      phone,
    });
    await company.save();

    // Create admin user
    const admin = new User({
      name: adminName,
      email: adminEmail,
      password,
      role: "admin",
      employeeId: "ADMIN001",
      department: "Administration",
      position: "Administrator",
      joinDate: new Date(),
      company: company._id,
      phone: phone || "",
      status: "active", // Admin is automatically active when creating company
      isActive: true, // Ensure admin is active
    });

    console.log("Creating admin user with data:", {
      name: adminName,
      email: adminEmail,
      role: "admin",
      department: "Administration",
      position: "Administrator",
      status: "active",
    });

    await admin.save();
    console.log("Admin user created successfully:", admin._id);

    // Generate token
    const token = generateToken({
      id: admin._id,
      role: admin.role,
      company: company._id,
    });

    res.status(201).json({
      message: "Company registered successfully",
      token,
      user: serializeAuthUser({ ...admin.toObject(), company }),
    });
  } catch (error) {
    console.error("Registration error:", error);
    console.error("Error stack:", error.stack);
    console.error("Request body:", req.body);

    // Handle specific validation errors
    if (error.name === "ValidationError") {
      const validationErrors = Object.values(error.errors).map(
        (err) => err.message
      );
      return res.status(400).json({
        message: "Validation failed",
        errors: validationErrors,
      });
    }

    // Handle MongoDB duplicate key errors
    if (error.code === 11000) {
      const field = Object.keys(error.keyValue)[0];
      return res.status(400).json({
        message: `${field} already exists`,
        error: `Duplicate ${field}: ${error.keyValue[field]}`,
      });
    }

    res.status(500).json({
      message: "Registration failed",
      error: error.message,
      stack: process.env.NODE_ENV === "development" ? error.stack : undefined,
    });
  }
});

// Login
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    // Find user and include password for comparison
    const user = await User.findOne({ email })
      .select("+password")
      .populate("company");

    if (!user || !user.isActive) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    if (user.status !== "active") {
      return res
        .status(401)
        .json({
          message:
            "Account not verified. Please check your email for verification link.",
        });
    }

    // Check password
    const isPasswordValid = await user.comparePassword(password);
    if (!isPasswordValid) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    // Generate token
    const token = generateToken({
      id: user._id,
      role: user.role,
      company: user.company._id,
    });

    res.status(200).json({
      message: "Login successful",
      token,
      user: serializeAuthUser(user),
    });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({
      message: "Login failed",
      error: error.message,
    });
  }
});

// Invite employee
router.post("/invite-employee", authenticateToken, validatePhoneField("phone"), async (req, res) => {
  console.log("=== INVITE ROUTE HIT === REQUEST RECEIVED ===");
  console.log("Method:", req.method, "URL:", req.url);
  console.log("Body:", req.body);
  console.log("User:", req.user?.email);

  const startTime = Date.now();

  try {
    console.log("INVITE ROUTE START:", new Date().toISOString());

    // Only admins can invite employees
    if (req.user.role !== "admin") {
      return res
        .status(403)
        .json({ message: "Only admins can invite employees" });
    }

    const { name, email, phone, department, position, joinDate, employeeId } =
      req.body;
    console.log("Processing invite for:", email);
    console.log("Custom Employee ID provided:", employeeId);

    // An existing record does NOT always mean "already registered".
    //
    // The employee row is created BEFORE the invitation email is sent, so any
    // send failure (bad provider config, network, quota) leaves behind a
    // `pending` user who never received anything. Rejecting those outright
    // made the address permanently un-invitable and produced a confusing
    // "Email already registered" for someone who was never actually
    // registered. Only an ACCEPTED invite (status !== "pending") is a genuine
    // conflict; a still-pending one is re-invited below.
    console.log("Checking for existing user:", email);
    const existingUser = await User.findOne({ email });

    if (existingUser && existingUser.status !== "pending") {
      console.log("Email belongs to an active account:", email);
      return res.status(400).json({
        message: "Email already registered",
        hint: "This person has already accepted an invitation and has an active account.",
      });
    }

    const isResend = !!existingUser;
    if (isResend) {
      console.log("Existing PENDING invite found - resending instead of failing.");
    } else {
      console.log("Email available:", email);
    }

    // Check if custom employeeId already exists (if provided).
    // Exclude the pending record we're about to re-invite, or it would
    // collide with itself.
    if (employeeId) {
      console.log("Checking for existing employeeId:", employeeId);
      const employeeIdQuery = {
        employeeId,
        company: req.user.company,
        ...(existingUser && { _id: { $ne: existingUser._id } }),
      };
      const existingEmployee = await User.findOne(employeeIdQuery);
      if (existingEmployee) {
        console.log("Employee ID already exists:", employeeId);
        return res.status(400).json({ message: "Employee ID already exists" });
      }
      console.log("Employee ID available:", employeeId);
    }

    // Reuse the pending record on a resend so we don't create duplicates;
    // otherwise create a fresh one.
    let employee;
    if (isResend) {
      employee = existingUser;
      employee.name = name;
      employee.department = department;
      employee.position = position;
      employee.joinDate = new Date(joinDate);
      employee.company = req.user.company;
      employee.invitedBy = req.user._id;
      employee.status = "pending";
      if (employeeId) employee.employeeId = employeeId;
      // Only overwrite a stored number when a new one was supplied, so a
      // resend does not wipe a number the employee set themselves.
      if (phone) employee.phone = phone;
      console.log("Updating existing pending employee record...");
    } else {
      console.log("Creating employee record...");
      employee = new User({
        name,
        email,
        role: "employee",
        department,
        position,
        joinDate: new Date(joinDate),
        company: req.user.company,
        invitedBy: req.user._id,
        status: "pending",
        ...(phone && { phone }), // Enables WhatsApp notifications for this user
        ...(employeeId && { employeeId }), // Use custom employeeId if provided
      });
    }

    // Generate a fresh invitation token (invalidates any previous link)
    console.log("Generating invitation token...");
    const invitationToken = employee.generateInvitationToken();

    console.log("Saving employee to database...");
    await employee.save();
    console.log(`Employee ${isResend ? "updated" : "saved"} in database`);

    // Queue email for background processing instead of sending synchronously
    const emailQueue = require("../utils/emailQueue");
    const emailJobId = emailQueue.add(
      "INVITATION_EMAIL",
      {
        employee: {
          ...employee.toObject(),
          company: req.user.company.name,
        },
        token: invitationToken,
        inviterName: req.user.name,
        role: "employee",
      },
      "high"
    ); // High priority for invitations

    const totalTime = Date.now() - startTime;
    console.log(
      `Employee ${isResend ? "re-invited" : "created"} and email queued in ${totalTime}ms`
    );
    console.log(`Email job ID: ${emailJobId}`);

    // Respond immediately with success
    res.status(isResend ? 200 : 201).json({
      message: isResend
        ? "Invitation resent - a new invitation email will be sent shortly"
        : "Employee invitation created successfully - email will be sent shortly",
      resent: isResend,
      employee: {
        id: employee._id,
        name: employee.name,
        email: employee.email,
        employeeId: employee.employeeId,
        department: employee.department,
        position: employee.position,
        status: employee.status,
      },
      emailQueued: true,
      emailJobId: emailJobId,
      processingTime: totalTime,
      note: "Email delivery is processing in background - employee will receive invitation shortly",
    });
    console.log("SUCCESS response sent to frontend");
  } catch (error) {
    const totalTime = Date.now() - startTime;
    console.error("Invite route error:", error.message);
    console.error(`Failed after ${totalTime}ms`);

    res.status(500).json({
      message: "Failed to invite employee",
      error: error.message,
      processingTime: totalTime,
      timestamp: new Date().toISOString(),
    });
    console.log("ERROR response sent to frontend");
  }
});

// Invite admin
router.post("/invite-admin", authenticateToken, validatePhoneField("phone"), async (req, res) => {
  try {
    // Only admins can invite other admins
    if (req.user.role !== "admin") {
      return res
        .status(403)
        .json({ message: "Only admins can invite other admins" });
    }

    const {
      name,
      email,
      phone,
      department = "Administration",
      position = "Administrator",
    } = req.body;

    // A still-pending record means the invite was created but never accepted
    // (commonly because an earlier email send failed). Re-invite rather than
    // permanently blocking the address - see the employee invite route above.
    const existingUser = await User.findOne({ email });
    if (existingUser && existingUser.status !== "pending") {
      return res.status(400).json({
        message: "Email already registered",
        hint: "This person has already accepted an invitation and has an active account.",
      });
    }

    const isResend = !!existingUser;
    let admin;
    if (isResend) {
      admin = existingUser;
      admin.name = name;
      admin.role = "admin";
      admin.department = department;
      admin.position = position;
      admin.company = req.user.company;
      admin.invitedBy = req.user._id;
      admin.status = "pending";
      // Only overwrite a stored number when a new one was supplied.
      if (phone) admin.phone = phone;
      console.log("Existing PENDING admin invite found - resending.");
    } else {
      admin = new User({
        name,
        email,
        role: "admin",
        department,
        position,
        joinDate: new Date(),
        company: req.user.company,
        invitedBy: req.user._id,
        status: "pending",
        ...(phone && { phone }), // Enables WhatsApp notifications for this user
      });
    }

    // Generate a fresh invitation token (invalidates any previous link)
    const invitationToken = admin.generateInvitationToken();

    await admin.save();

    // Send invitation email
    const { sendInvitationEmail } = require("../utils/email");
    console.log("Sending admin invitation email to:", email);

    try {
      await sendInvitationEmail(
        {
          ...admin.toObject(),
          company: req.user.company.name,
        },
        invitationToken,
        req.user.name,
        "admin"
      );

      console.log("Admin invitation email sent successfully");
      res.status(201).json({
        message: "Admin invitation sent successfully",
        admin: {
          id: admin._id,
          name: admin.name,
          email: admin.email,
          employeeId: admin.employeeId,
          department: admin.department,
          position: admin.position,
          status: admin.status,
        },
      });
    } catch (emailError) {
      console.error("Admin email sending error:", emailError.message);
      console.error("Full admin email error:", emailError);

      // Return success but with email warning - don't fail the invitation
      return res.status(201).json({
        message:
          "Admin invitation created successfully, but email delivery failed. Please share the invitation link manually.",
        warning: "Email delivery failed",
        emailError: emailError.message,
        admin: {
          id: admin._id,
          name: admin.name,
          email: admin.email,
          employeeId: admin.employeeId,
          department: admin.department,
          position: admin.position,
          status: admin.status,
        },
        invitationToken: invitationToken,
        manualInviteUrl: `${
          process.env.FRONTEND_URL || "http://localhost:3000"
        }/verify-invitation/${invitationToken}`,
        troubleshooting: {
          message: "Check Railway logs for detailed email configuration issues",
          debugEndpoint: "/api/debug/email-config",
          testEndpoint: "/api/debug/test-email",
        },
      });
    }
  } catch (error) {
    console.error("Invite admin error:", error);
    res.status(500).json({
      message: "Failed to invite admin",
      error: error.message,
    });
  }
});

// Get current user profile
router.get("/profile", authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user._id).populate("company");

    res.status(200).json({ user: serializeAuthUser(user) });
  } catch (error) {
    res
      .status(500)
      .json({ message: "Failed to get profile", error: error.message });
  }
});

// Verify invitation and set password
router.post("/verify-invitation/:token", async (req, res) => {
  try {
    const { token } = req.params;
    const { password } = req.body;

    if (!password) {
      return res.status(400).json({ message: "Password is required" });
    }

    if (password.length < 6) {
      return res
        .status(400)
        .json({ message: "Password must be at least 6 characters long" });
    }

    // Hash the token to compare with database
    const crypto = require("crypto");
    const hashedToken = crypto.createHash("sha256").update(token).digest("hex");

    // Find user by invitation token
    const user = await User.findOne({
      invitationToken: hashedToken,
      invitationExpires: { $gt: Date.now() },
    }).populate("company");

    if (!user) {
      return res
        .status(400)
        .json({ message: "Invalid or expired invitation token" });
    }

    // Set password and activate user
    user.password = password;
    user.status = "active";
    user.invitationToken = undefined;
    user.invitationExpires = undefined;

    await user.save();

    // Generate JWT token
    const jwtToken = generateToken({
      id: user._id,
      role: user.role,
      company: user.company._id,
    });

    // Send notification to admins about employee joining
    const { sendEmployeeJoinedNotification } = require("../utils/email");
    const admins = await User.find({
      company: user.company._id,
      role: "admin",
      status: "active",
    });

    for (const admin of admins) {
      try {
        await sendEmployeeJoinedNotification(admin, user);
      } catch (emailError) {
        console.error(
          "Failed to send employee joined notification:",
          emailError
        );
      }
    }

    res.status(200).json({
      message: "Account verified successfully",
      token: jwtToken,
      user: serializeAuthUser(user),
    });
  } catch (error) {
    console.error("Verification error:", error);
    res.status(500).json({
      message: "Failed to verify invitation",
      error: error.message,
    });
  }
});

// Get invitation details (for verification page)
router.get("/invitation/:token", async (req, res) => {
  try {
    const { token } = req.params;

    // Hash the token to compare with database
    const crypto = require("crypto");
    const hashedToken = crypto.createHash("sha256").update(token).digest("hex");

    // Find user by invitation token
    const user = await User.findOne({
      invitationToken: hashedToken,
      invitationExpires: { $gt: Date.now() },
    })
      .populate("company")
      .populate("invitedBy", "name");

    if (!user) {
      return res
        .status(400)
        .json({ message: "Invalid or expired invitation token" });
    }

    res.status(200).json({
      user: {
        name: user.name,
        email: user.email,
        role: user.role,
        department: user.department,
        position: user.position,
        company: user.company.name,
        invitedBy: user.invitedBy.name,
      },
    });
  } catch (error) {
    console.error("Get invitation error:", error);
    res.status(500).json({
      message: "Failed to get invitation details",
      error: error.message,
    });
  }
});

// Forgot password - Request reset link
router.post("/forgot-password", async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ message: "Email is required" });
    }

    // Find user by email
    const user = await User.findOne({
      email: email.toLowerCase(),
      status: "active", // Only active users can reset password
    }).populate("company");

    if (!user) {
      // For security, always send success response even if user doesn't exist
      return res.status(200).json({
        message:
          "If an account exists with that email, you will receive a password reset link shortly.",
      });
    }

    // Generate password reset token
    const resetToken = user.generatePasswordResetToken();
    await user.save();

    // Send password reset email
    const { sendPasswordResetEmail } = require("../utils/email");
    await sendPasswordResetEmail(
      {
        ...user.toObject(),
        company: user.company.name,
      },
      resetToken
    );

    res.status(200).json({
      message:
        "If an account exists with that email, you will receive a password reset link shortly.",
    });
  } catch (error) {
    console.error("Forgot password error:", error);
    res.status(500).json({
      message: "Failed to process password reset request",
      error: error.message,
    });
  }
});

// Reset password with token
router.post("/reset-password/:token", async (req, res) => {
  try {
    const { token } = req.params;
    const { password } = req.body;

    if (!password) {
      return res.status(400).json({ message: "Password is required" });
    }

    if (password.length < 6) {
      return res
        .status(400)
        .json({ message: "Password must be at least 6 characters long" });
    }

    // Hash the token to compare with database
    const crypto = require("crypto");
    const hashedToken = crypto.createHash("sha256").update(token).digest("hex");

    // Find user by reset token
    const user = await User.findOne({
      passwordResetToken: hashedToken,
      passwordResetExpires: { $gt: Date.now() },
    });

    if (!user) {
      return res
        .status(400)
        .json({ message: "Invalid or expired password reset token" });
    }

    // Update password and clear reset fields
    user.password = password;
    user.passwordResetToken = undefined;
    user.passwordResetExpires = undefined;

    await user.save();

    res.status(200).json({
      message:
        "Password reset successfully. You can now log in with your new password.",
    });
  } catch (error) {
    console.error("Reset password error:", error);
    res.status(500).json({
      message: "Failed to reset password",
      error: error.message,
    });
  }
});

// Validate reset token (for frontend to check if token is valid)
router.get("/reset-password/:token", async (req, res) => {
  try {
    const { token } = req.params;

    // Hash the token to compare with database
    const crypto = require("crypto");
    const hashedToken = crypto.createHash("sha256").update(token).digest("hex");

    // Find user by reset token
    const user = await User.findOne({
      passwordResetToken: hashedToken,
      passwordResetExpires: { $gt: Date.now() },
    }).select("name email");

    if (!user) {
      return res
        .status(400)
        .json({ message: "Invalid or expired password reset token" });
    }

    res.status(200).json({
      valid: true,
      user: {
        name: user.name,
        email: user.email,
      },
    });
  } catch (error) {
    console.error("Validate reset token error:", error);
    res.status(500).json({
      message: "Failed to validate reset token",
      error: error.message,
    });
  }
});

// Change password (for authenticated users)
router.put("/change-password", authenticateToken, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    const user = await User.findById(req.user._id).select("+password");

    // Verify current password
    const isPasswordValid = await user.comparePassword(currentPassword);
    if (!isPasswordValid) {
      return res.status(400).json({ message: "Current password is incorrect" });
    }

    // Update password
    user.password = newPassword;
    await user.save();

    res.status(200).json({ message: "Password changed successfully" });
  } catch (error) {
    res.status(500).json({
      message: "Failed to change password",
      error: error.message,
    });
  }
});

// Update employee leave quota (Admin only)
router.put("/leave-quota/:employeeId", authenticateToken, async (req, res) => {
  try {
    // Only admins can set leave quotas
    if (req.user.role !== "admin") {
      return res
        .status(403)
        .json({ message: "Only admins can set leave quotas" });
    }

    const { employeeId } = req.params;
    const { leaveQuota } = req.body;

    // Find employee in the same company
    const employee = await User.findOne({
      _id: employeeId,
      company: req.user.company._id,
    });

    if (!employee) {
      return res.status(404).json({ message: "Employee not found" });
    }

    // Update leave quota
    employee.leaveQuota = { ...employee.leaveQuota, ...leaveQuota };
    await employee.save();

    res.status(200).json({
      message: "Leave quota updated successfully",
      employee: {
        id: employee._id,
        name: employee.name,
        email: employee.email,
        leaveQuota: employee.leaveQuota,
      },
    });
  } catch (error) {
    console.error("Update leave quota error:", error);
    res.status(500).json({
      message: "Failed to update leave quota",
      error: error.message,
    });
  }
});

// Get employee leave balance
router.get(
  "/leave-balance/:employeeId?",
  authenticateToken,
  async (req, res) => {
    try {
      const { employeeId } = req.params;
      let targetUserId;

      // If employeeId is provided and user is admin, get that employee's balance
      // Otherwise, get current user's balance
      if (employeeId && req.user.role === "admin") {
        const employee = await User.findOne({
          _id: employeeId,
          company: req.user.company._id,
        });
        if (!employee) {
          return res.status(404).json({ message: "Employee not found" });
        }
        targetUserId = employee._id;
      } else {
        targetUserId = req.user._id;
      }

      const user = await User.findById(targetUserId);
      const leaveBalances = await user.getAllLeaveBalances();

      res.status(200).json({
        employeeId: targetUserId,
        name: user.name,
        leaveBalances,
      });
    } catch (error) {
      console.error("Get leave balance error:", error);
      res.status(500).json({
        message: "Failed to get leave balance",
        error: error.message,
      });
    }
  }
);

// Get email queue status (Admin only)
router.get("/email-queue/status", authenticateToken, async (req, res) => {
  try {
    // Only admins can check email queue status
    if (req.user.role !== "admin") {
      return res
        .status(403)
        .json({ message: "Only admins can check email queue status" });
    }

    const emailQueue = require("../utils/emailQueue");
    const status = emailQueue.getStatus();

    res.status(200).json({
      message: "Email queue status retrieved successfully",
      ...status,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Get email queue status error:", error);
    res.status(500).json({
      message: "Failed to get email queue status",
      error: error.message,
    });
  }
});

// Get specific email job status
router.get("/email-queue/job/:jobId", authenticateToken, async (req, res) => {
  try {
    // Only admins can check email job status
    if (req.user.role !== "admin") {
      return res
        .status(403)
        .json({ message: "Only admins can check email job status" });
    }

    const { jobId } = req.params;
    const emailQueue = require("../utils/emailQueue");
    const job = emailQueue.getJob(parseInt(jobId));

    if (!job) {
      return res.status(404).json({ message: "Email job not found" });
    }

    res.status(200).json({
      message: "Email job status retrieved successfully",
      job: job,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Get email job status error:", error);
    res.status(500).json({
      message: "Failed to get email job status",
      error: error.message,
    });
  }
});

module.exports = router;
