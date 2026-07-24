const express = require("express");
const {
  authenticateToken,
  authorizeRoles,
  checkCompanyAccess,
} = require("../middleware/auth");
const { uploadSingle, processProfilePicture } = require("../middleware/upload");
const User = require("../models/User");
const { sendInvitationEmail } = require("../utils/email");

const router = express.Router();

// Get all employees (Admin only)
router.get(
  "/",
  authenticateToken,
  authorizeRoles("admin"),
  async (req, res) => {
    try {
      console.log("👥 === EMPLOYEES DEBUG ===");
      console.log("👥 req.user exists:", !!req.user);
      console.log("👥 req.user:", req.user);

      if (!req.user) {
        console.log("👥 ERROR: req.user is undefined!");
        return res
          .status(401)
          .json({ message: "Authentication failed - user not found" });
      }
      console.log("👥 Employees request from user:", req.user.email);
      console.log("👥 User company:", req.user.company);
      console.log("👥 Company ID:", req.user.company?._id);

      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 50; // Increased default limit for employees
      const skip = (page - 1) * limit;

      // Include ALL employees (active + inactive) for comprehensive view
      const companyId = req.user.company._id || req.user.company;
      console.log("👥 Using company ID for queries:", companyId);

      const users = await User.find({
        company: companyId,
        role: "employee",
      })
        .select("-password")
        .populate("company", "name")
        .skip(skip)
        .limit(limit)
        .sort({ createdAt: -1 });

      console.log("📋 Retrieved employees:", users.length);
      console.log(
        "📋 Employee statuses:",
        users.map((u) => ({
          name: u.name,
          status: u.status,
          isActive: u.isActive,
          email: u.email,
        }))
      );

      const total = await User.countDocuments({
        company: companyId,
        role: "employee",
      });

      // Get active employee count for comparison with Dashboard
      const activeEmployees = await User.countDocuments({
        company: companyId,
        role: "employee",
        isActive: true,
      });

      console.log(
        `Employee listing debug - Found ${total} total employees, ${activeEmployees} active employees, returning ${users.length} employees`
      );
      console.log(
        "Employee details:",
        users.map((u) => ({
          name: u.name,
          employeeId: u.employeeId,
          isActive: u.isActive,
          status: u.status,
        }))
      );

      res.status(200).json({
        employees: users,
        pagination: {
          current: page,
          pages: Math.ceil(total / limit),
          total,
        },
      });
    } catch (error) {
      res.status(500).json({
        message: "Failed to get employees",
        error: error.message,
      });
    }
  }
);

// Get all admins (Admin only)
router.get(
  "/admins/list",
  authenticateToken,
  authorizeRoles("admin"),
  async (req, res) => {
    console.log("👥 Admins request from user:", req.user.email);
    console.log("👥 User company:", req.user.company);
    console.log("👥 Company ID:", req.user.company?._id);
    try {
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 50;
      const skip = (page - 1) * limit;

      const companyId = req.user.company._id || req.user.company;
      console.log("👥 Using company ID for admins queries:", companyId);
      const users = await User.find({
        company: companyId,
        role: "admin",
      })
        .select("-password")
        .populate("company", "name")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit);

      const total = await User.countDocuments({
        company: companyId,
        role: "admin",
      });

      res.status(200).json({
        admins: users,
        pagination: {
          current: page,
          pages: Math.ceil(total / limit),
          total,
        },
      });
    } catch (error) {
      res.status(500).json({
        message: "Failed to get admins",
        error: error.message,
      });
    }
  }
);

// Get single employee (Admin can get any, Employee can get only themselves)
router.get("/:id", authenticateToken, checkCompanyAccess, async (req, res) => {
  try {
    let query = { _id: req.params.id };

    // If user is not admin, they can only see their own profile
    if (req.user.role !== "admin") {
      query._id = req.user._id;
    } else {
      // Admin can only see employees from their company
      query.company = req.user.company._id;
    }

    const user = await User.findOne(query)
      .select("-password")
      .populate("company", "name");

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    res.status(200).json({ user });
  } catch (error) {
    res.status(500).json({
      message: "Failed to get user",
      error: error.message,
    });
  }
});

// Update employee profile (Admin can update any, Employee can update only themselves)
router.put("/:id", authenticateToken, checkCompanyAccess, async (req, res) => {
  try {
    const { name, phone, department, position } = req.body;

    let query = { _id: req.params.id };

    // If user is not admin, they can only update their own profile
    if (req.user.role !== "admin") {
      query._id = req.user._id;
      // Employees can only update limited fields
      const allowedUpdates = { name, phone };
      Object.keys(allowedUpdates).forEach(
        (key) => allowedUpdates[key] === undefined && delete allowedUpdates[key]
      );
      req.body = allowedUpdates;
    } else {
      // Admin can update more fields
      query.company = req.user.company._id;
      const allowedUpdates = { name, phone, department, position };
      Object.keys(allowedUpdates).forEach(
        (key) => allowedUpdates[key] === undefined && delete allowedUpdates[key]
      );
      req.body = allowedUpdates;
    }

    const user = await User.findOneAndUpdate(query, req.body, {
      new: true,
      runValidators: true,
    })
      .select("-password")
      .populate("company", "name");

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    res.status(200).json({
      message: "Profile updated successfully",
      user,
    });
  } catch (error) {
    res.status(500).json({
      message: "Failed to update profile",
      error: error.message,
    });
  }
});

// Deactivate employee (Admin only)
router.put(
  "/:id/deactivate",
  authenticateToken,
  authorizeRoles("admin"),
  async (req, res) => {
    try {
      const companyId = req.user.company._id || req.user.company; // Add this line

      const user = await User.findOneAndUpdate(
        {
          _id: req.params.id,
          company: companyId,
          role: "employee", // Can't deactivate other admins
        },
        { isActive: false },
        { new: true }
      ).select("-password");

      if (!user) {
        return res.status(404).json({ message: "Employee not found" });
      }

      res.status(200).json({
        message: "Employee deactivated successfully",
        user,
      });
    } catch (error) {
      res.status(500).json({
        message: "Failed to deactivate employee",
        error: error.message,
      });
    }
  }
);

// Activate employee (Admin only)
router.put(
  "/:id/activate",
  authenticateToken,
  authorizeRoles("admin"),
  async (req, res) => {
    try {
      const companyId = req.user.company._id || req.user.company; // Add this line

      const user = await User.findOneAndUpdate(
        {
          _id: req.params.id,
          company: companyId,
          role: "employee",
        },
        { isActive: true },
        { new: true }
      ).select("-password");

      if (!user) {
        return res.status(404).json({ message: "Employee not found" });
      }

      res.status(200).json({
        message: "Employee activated successfully",
        user,
      });
    } catch (error) {
      res.status(500).json({
        message: "Failed to activate employee",
        error: error.message,
      });
    }
  }
);

// Delete employee (Admin only)
router.delete(
  "/:id",
  authenticateToken,
  authorizeRoles("admin"),
  async (req, res) => {
    try {
      const companyId = req.user.company._id || req.user.company; // Add this line
      const employeeId = req.params.id;

      // Check if employee exists and belongs to the same company
      const employee = await User.findOne({
        _id: employeeId,
        company: companyId,
        role: "employee", // Can't delete other admins
      }).select("-password");

      if (!employee) {
        return res.status(404).json({ message: "Employee not found" });
      }

      // Delete all leaves for this employee (including pending/approved ones)
      // Admin has full control to delete employees regardless of leave status
      const Leave = require("../models/Leave");
      await Leave.deleteMany({ employee: employeeId });

      // Delete the employee
      await User.findByIdAndDelete(employeeId);

      res.status(200).json({
        message: "Employee deleted successfully",
        deletedEmployee: {
          id: employee._id,
          name: employee.name,
          email: employee.email,
          employeeId: employee.employeeId,
        },
      });
    } catch (error) {
      console.error("Delete employee error:", error);
      res.status(500).json({
        message: "Failed to delete employee",
        error: error.message,
      });
    }
  }
);

// Upload profile picture
router.post(
  "/profile-picture",
  authenticateToken,
  uploadSingle,
  processProfilePicture,
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ message: "No file uploaded" });
      }

      // Update user's profile picture
      const user = await User.findByIdAndUpdate(
        req.user._id,
        {
          profilePicture: req.profilePicturePath,
          profilePictureUploadedAt: new Date(), // Track when file was uploaded
        },
        { new: true }
      ).select("-password");

      res.status(200).json({
        message: "Profile picture updated successfully",
        profilePicture: req.profilePicturePath,
        warning:
          "Note: On Railway, uploaded files may be lost on app restart. Consider using a cloud storage service for persistent file storage.",
        user: {
          id: user._id,
          name: user.name,
          email: user.email,
          role: user.role,
          employeeId: user.employeeId,
          department: user.department,
          position: user.position,
          company: user.company,
          joinDate: user.joinDate,
          phone: user.phone,
          profilePicture: user.profilePicture,
          isActive: user.isActive,
        },
      });
    } catch (error) {
      console.error("Profile picture upload error:", error);
      res.status(500).json({
        message: "Failed to upload profile picture",
        error: error.message,
      });
    }
  }
);

// POST /api/users - Create user (used for invitations)
router.post(
  "/",
  authenticateToken,
  authorizeRoles("admin"),
  async (req, res) => {
    try {
      console.log("🔴 === DEBUG START ===");
      console.log("🔴 req.body:", JSON.stringify(req.body, null, 2));
      console.log("🔴 req.user:", JSON.stringify(req.user, null, 2));
      console.log("🔴 req.user.company:", req.user.company);
      console.log("🔴 req.user.company._id:", req.user.company?._id);
      console.log("🔴 === DEBUG END ===");

      const {
        name,
        email,
        role,
        department,
        position,
        joinDate,
        employeeId,
        tags,
        sendInviteEmail,
      } = req.body;

      console.log("📝 Creating new user:", { name, email, role, department });
      console.log("📝 Request user:", req.user.email);
      console.log("📝 Company from req.user:", req.user.company);

      // Check if user already exists
      const existingUser = await User.findOne({ email: email.toLowerCase() });
      if (existingUser) {
        return res.status(400).json({
          message: "User with this email already exists",
        });
      }

      // Get company ID properly - CRITICAL FIX
      const companyId = req.user.company?._id || req.user.company;

      // Verify companyId is valid
      if (!companyId) {
        console.error("❌ No company ID found for admin:", req.user.email);
        return res.status(400).json({
          message: "Admin user has no company association",
        });
      }

      console.log("✅ Using company ID:", companyId);

      // Create user with pending status
      const user = await User.create({
        name,
        email: email.toLowerCase(),
        role: role || "employee",
        status: "pending",
        department,
        position,
        joinDate,
        employeeId: employeeId || undefined,
        company: companyId, // Use extracted company ObjectId
        invitedBy: req.user._id,
        tags: tags || [],
      });

      console.log("✅ User created successfully:", user.employeeId);
      console.log("✅ User company:", user.company);

      // Generate invitation token
      const invitationToken = user.generateInvitationToken();
      await user.save({ validateBeforeSave: false });

      console.log("🔑 Invitation token generated");

      // Populate company name for email
      await user.populate("company", "name");
      const companyName = user.company?.name || "Your Company";

      console.log("🏢 Company name for email:", companyName);

      // Send invitation email if requested
      let emailSent = false;
      let emailError = null;
      let emailMessageId = null;

      if (sendInviteEmail !== false) {
        try {
          console.log("📧 Sending invitation email to:", email);

          // Create email-friendly user object
          const emailUser = {
            ...user.toObject(),
            company: companyName, // Use string name for email
          };

          const emailResult = await sendInvitationEmail(
            emailUser,
            invitationToken,
            req.user.name,
            role
          );
          emailSent = true;
          emailMessageId = emailResult?.messageId;
          console.log("✅ Invitation email sent successfully");
        } catch (error) {
          console.error("❌ Failed to send invitation email:", error.message);
          emailError = error.message;
          // Don't fail the request if email fails
        }
      }

      res.status(201).json({
        message: "Employee invited successfully",
        user: {
          _id: user._id,
          name: user.name,
          email: user.email,
          role: user.role,
          employeeId: user.employeeId,
          department: user.department,
          position: user.position,
          status: user.status,
          company: companyName,
        },
        emailSent,
        emailMessageId,
        emailError,
        warning: emailError ? "User created but invitation email failed" : null,
      });
    } catch (error) {
      console.error("❌ Error creating user:", error);
      console.error("❌ Error stack:", error.stack);
      res.status(500).json({
        message: "Failed to create user",
        error: error.message,
        details: error.stack,
      });
    }
  }
);

module.exports = router;
