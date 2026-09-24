const express = require("express");
const {
  authenticateToken,
  authorizeRoles,
  checkCompanyAccess,
} = require("../middleware/auth");
const { uploadSingle, processProfilePicture } = require("../middleware/upload");
const { validatePhoneField } = require("../middleware/phoneValidation");
const { validate, z, schemas } = require("../middleware/validate");
const { uploadLimiter, inviteLimiter } = require("../middleware/rateLimits");
const { serializeAuthUser } = require("../utils/serializeUser");
const sessions = require("../services/sessionService");
const audit = require("../services/auditLog");
const User = require("../models/User");
const { sendInvitationEmail } = require("../utils/email");

const router = express.Router();

const MAX_PAGE_SIZE = 200;

const pagination = (query) => {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(query.limit, 10) || 50));
  return { page, limit, skip: (page - 1) * limit };
};

const idParams = z.object({ id: schemas.objectId });

// Fields never returned by the user-management endpoints.
const PRIVATE_FIELDS =
  "-password -invitationToken -invitationExpires -passwordResetToken -passwordResetExpires";

// Get all employees (Admin only)
router.get("/", authenticateToken, authorizeRoles("admin"), async (req, res) => {
  try {
    const { page, limit, skip } = pagination(req.query);
    const companyId = req.user.company._id;

    // Include ALL employees (active + inactive) for comprehensive view
    const [users, total] = await Promise.all([
      User.find({ company: companyId, role: "employee" })
        .select(PRIVATE_FIELDS)
        .populate("company", "name")
        .skip(skip)
        .limit(limit)
        .sort({ createdAt: -1 }),
      User.countDocuments({ company: companyId, role: "employee" }),
    ]);

    res.status(200).json({
      employees: users,
      pagination: { current: page, pages: Math.ceil(total / limit), total },
    });
  } catch (error) {
    console.error("List employees error:", error.message);
    res.status(500).json({ message: "Failed to get employees" });
  }
});

// Get all admins (Admin only)
router.get("/admins/list", authenticateToken, authorizeRoles("admin"), async (req, res) => {
  try {
    const { page, limit, skip } = pagination(req.query);
    const companyId = req.user.company._id;

    const [users, total] = await Promise.all([
      User.find({ company: companyId, role: "admin" })
        .select(PRIVATE_FIELDS)
        .populate("company", "name")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
      User.countDocuments({ company: companyId, role: "admin" }),
    ]);

    res.status(200).json({
      admins: users,
      pagination: { current: page, pages: Math.ceil(total / limit), total },
    });
  } catch (error) {
    console.error("List admins error:", error.message);
    res.status(500).json({ message: "Failed to get admins" });
  }
});

// Get single employee (Admin can get any in their company, employee only themselves)
router.get(
  "/:id",
  authenticateToken,
  validate({ params: idParams }),
  checkCompanyAccess,
  async (req, res) => {
    try {
      const query =
        req.user.role === "admin"
          ? { _id: req.params.id, company: req.user.company._id }
          : { _id: req.user._id };

      const user = await User.findOne(query)
        .select(PRIVATE_FIELDS)
        .populate("company", "name");

      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }

      res.status(200).json({ user });
    } catch (error) {
      console.error("Get user error:", error.message);
      res.status(500).json({ message: "Failed to get user" });
    }
  }
);

// Update profile. Employees may change their own name and phone; admins may
// also change department and position of anyone in their company. Nothing else
// (role, company, status, quotas...) is writable here.
const profileUpdateSchema = z.object({
  name: schemas.personName.optional(),
  phone: z.union([z.literal(""), schemas.phone, z.null()]).optional(),
  department: schemas.shortText(100).pipe(z.string().min(1)).optional(),
  position: schemas.shortText(100).pipe(z.string().min(1)).optional(),
});

router.put(
  "/:id",
  authenticateToken,
  validate({ params: idParams }),
  checkCompanyAccess,
  validatePhoneField("phone"),
  validate({ body: profileUpdateSchema }),
  async (req, res) => {
    try {
      const { name, phone, department, position } = req.body;
      const isAdmin = req.user.role === "admin";

      const query = isAdmin
        ? { _id: req.params.id, company: req.user.company._id }
        : { _id: req.user._id };
      const update = isAdmin ? { name, phone, department, position } : { name, phone };
      Object.keys(update).forEach((key) => update[key] === undefined && delete update[key]);

      const user = await User.findOneAndUpdate(query, update, {
        new: true,
        runValidators: true,
      })
        .select(PRIVATE_FIELDS)
        .populate("company", "name");

      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }

      audit.record({
        req,
        action: "user.profile.update",
        targetType: "user",
        targetId: user._id,
        metadata: { fields: Object.keys(update) },
      });

      // Serialised, not the raw document: the client writes this straight into
      // its auth context.
      res.status(200).json({
        message: "Profile updated successfully",
        user: serializeAuthUser(user),
      });
    } catch (error) {
      if (error.name === "ValidationError") {
        return res.status(400).json({
          message: Object.values(error.errors)[0]?.message || "Validation failed",
        });
      }
      console.error("Update profile error:", error.message);
      res.status(500).json({ message: "Failed to update profile" });
    }
  }
);

// Deactivate employee (Admin only). Takes effect immediately: every session
// the employee has is revoked.
router.put(
  "/:id/deactivate",
  authenticateToken,
  authorizeRoles("admin"),
  validate({ params: idParams }),
  async (req, res) => {
    try {
      const user = await User.findOneAndUpdate(
        { _id: req.params.id, company: req.user.company._id, role: "employee" },
        { isActive: false },
        { new: true }
      ).select(PRIVATE_FIELDS);

      if (!user) {
        return res.status(404).json({ message: "Employee not found" });
      }

      await sessions.revokeAllForUser(user._id, "account_deactivated");
      audit.record({ req, action: "user.deactivate", targetType: "user", targetId: user._id });

      res.status(200).json({ message: "Employee deactivated successfully", user });
    } catch (error) {
      console.error("Deactivate employee error:", error.message);
      res.status(500).json({ message: "Failed to deactivate employee" });
    }
  }
);

// Activate employee (Admin only)
router.put(
  "/:id/activate",
  authenticateToken,
  authorizeRoles("admin"),
  validate({ params: idParams }),
  async (req, res) => {
    try {
      const user = await User.findOneAndUpdate(
        { _id: req.params.id, company: req.user.company._id, role: "employee" },
        { isActive: true },
        { new: true }
      ).select(PRIVATE_FIELDS);

      if (!user) {
        return res.status(404).json({ message: "Employee not found" });
      }

      audit.record({ req, action: "user.activate", targetType: "user", targetId: user._id });
      res.status(200).json({ message: "Employee activated successfully", user });
    } catch (error) {
      console.error("Activate employee error:", error.message);
      res.status(500).json({ message: "Failed to activate employee" });
    }
  }
);

// Delete employee (Admin only)
router.delete(
  "/:id",
  authenticateToken,
  authorizeRoles("admin"),
  validate({ params: idParams }),
  async (req, res) => {
    try {
      const employeeId = req.params.id;
      const employee = await User.findOne({
        _id: employeeId,
        company: req.user.company._id,
        role: "employee", // Can't delete other admins
      }).select(PRIVATE_FIELDS);

      if (!employee) {
        return res.status(404).json({ message: "Employee not found" });
      }

      // Admin has full control to delete employees regardless of leave status
      const Leave = require("../models/Leave");
      await Leave.deleteMany({ employee: employee._id, company: req.user.company._id });
      await User.deleteOne({ _id: employee._id, company: req.user.company._id });
      await sessions.revokeAllForUser(employee._id, "account_deleted");

      audit.record({
        req,
        action: "user.delete",
        targetType: "user",
        targetId: employee._id,
        metadata: { employeeId: employee.employeeId },
      });

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
      console.error("Delete employee error:", error.message);
      res.status(500).json({ message: "Failed to delete employee" });
    }
  }
);

// Upload profile picture (always the caller's own)
router.post(
  "/profile-picture",
  authenticateToken,
  uploadLimiter,
  uploadSingle,
  processProfilePicture,
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ message: "No file uploaded" });
      }

      const user = await User.findByIdAndUpdate(
        req.user._id,
        { profilePicture: req.profilePicturePath },
        { new: true }
      )
        .select(PRIVATE_FIELDS)
        .populate("company", "name");

      res.status(200).json({
        message: "Profile picture updated successfully",
        profilePicture: req.profilePicturePath,
        user: serializeAuthUser(user),
      });
    } catch (error) {
      console.error("Profile picture upload error:", error.message);
      res.status(500).json({ message: "Failed to upload profile picture" });
    }
  }
);

// POST /api/users - Create user (used for invitations)
const createUserSchema = z.object({
  name: schemas.personName,
  email: schemas.email,
  phone: z.union([z.literal(""), schemas.phone, z.null()]).optional(),
  role: z.enum(["admin", "employee"]).optional(),
  department: schemas.shortText(100).pipe(z.string().min(1, "is required")),
  position: schemas.shortText(100).pipe(z.string().min(1, "is required")),
  joinDate: schemas.isoDate,
  employeeId: z
    .string()
    .trim()
    .max(32)
    .regex(/^[A-Za-z0-9_-]*$/, "may only contain letters, numbers, - and _")
    .optional(),
  tags: z.array(z.string().trim().max(40)).max(20).optional(),
  sendInviteEmail: z.boolean().optional(),
});

router.post(
  "/",
  authenticateToken,
  authorizeRoles("admin"),
  inviteLimiter,
  validatePhoneField("phone"),
  validate({ body: createUserSchema }),
  async (req, res) => {
    try {
      const { name, email, phone, department, position, joinDate, tags, sendInviteEmail } =
        req.body;
      const role = req.body.role || "employee";
      const employeeId = req.body.employeeId || undefined;
      const companyId = req.user.company._id;

      // Only a still-pending invite in THIS company may be re-sent; anything
      // else (an active account, or a pending one elsewhere) is a conflict.
      const existingUser = await User.findOne({ email });
      if (
        existingUser &&
        (existingUser.status !== "pending" ||
          String(existingUser.company) !== String(companyId))
      ) {
        return res.status(400).json({
          message: "User with this email already exists",
          hint: "This person has already accepted an invitation and has an active account.",
        });
      }
      const isResend = !!existingUser;

      let user;
      if (isResend) {
        user = existingUser;
        Object.assign(user, {
          name,
          role,
          status: "pending",
          department,
          position,
          joinDate,
          invitedBy: req.user._id,
          tags: tags || [],
          ...(employeeId && { employeeId }),
          ...(phone && { phone }),
        });
        await user.save();
      } else {
        user = await User.create({
          name,
          email,
          phone: phone || undefined,
          role,
          status: "pending",
          department,
          position,
          joinDate,
          employeeId,
          company: companyId,
          invitedBy: req.user._id,
          tags: tags || [],
        });
      }

      const invitationToken = user.generateInvitationToken();
      await user.save({ validateBeforeSave: false });

      audit.record({
        req,
        action: isResend ? "user.invite.resend" : "user.invite",
        targetType: "user",
        targetId: user._id,
        metadata: { role },
      });

      await user.populate("company", "name");
      const companyName = user.company?.name || "Your Company";

      let emailSent = false;
      let emailFailed = false;
      let emailMessageId = null;

      if (sendInviteEmail !== false) {
        try {
          const emailResult = await sendInvitationEmail(
            { ...user.toObject(), company: companyName },
            invitationToken,
            req.user.name,
            role
          );
          emailSent = true;
          emailMessageId = emailResult?.messageId;
        } catch (error) {
          console.error("Failed to send invitation email:", error.message);
          emailFailed = true;
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
        warning: emailFailed ? "User created but invitation email failed" : null,
      });
    } catch (error) {
      if (error.name === "ValidationError") {
        return res.status(400).json({
          message: Object.values(error.errors)[0]?.message || "Validation failed",
        });
      }
      if (error.code === 11000) {
        return res.status(400).json({ message: "Employee ID or email already exists" });
      }
      console.error("Error creating user:", error.message);
      res.status(500).json({ message: "Failed to create user" });
    }
  }
);

module.exports = router;
