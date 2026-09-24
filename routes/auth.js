const express = require("express");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { authenticateToken, authorizeRoles } = require("../middleware/auth");
const { validatePhoneField } = require("../middleware/phoneValidation");
const { validate, z, schemas } = require("../middleware/validate");
const limits = require("../middleware/rateLimits");
const { serializeAuthUser } = require("../utils/serializeUser");
const sessions = require("../services/sessionService");
const audit = require("../services/auditLog");
const User = require("../models/User");
const Company = require("../models/Company");

const router = express.Router();

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

// Compared against when no account matches, so a sign-in for an unknown email
// costs the same bcrypt work as one for a real account and response timing
// does not reveal which emails are registered.
const DUMMY_PASSWORD_HASH = bcrypt.hashSync(crypto.randomBytes(16).toString("hex"), 12);

const INVALID_CREDENTIALS = { message: "Invalid email or password" };

/**
 * Public company sign-up creates a new tenant whose creator is an admin.
 * Off in production unless explicitly enabled, because every admin-only
 * capability would otherwise be one anonymous request away.
 */
const registrationEnabled = () => {
  const flag = process.env.ALLOW_COMPANY_REGISTRATION;
  if (flag !== undefined) return flag === "true";
  return process.env.NODE_ENV !== "production";
};

/** Issue a session and the response fields every sign-in endpoint returns. */
const startSession = async (user, req) => {
  const { token, refreshToken, expiresIn } = await sessions.createSession(user, req);
  return { token, refreshToken, expiresIn };
};

const optionalPhone = z.union([schemas.phone, z.null()]).optional();

/* ------------------------------------------------------------------ */
/*  Register company (public, disabled in production by default)       */
/* ------------------------------------------------------------------ */
const registerSchema = z.object({
  companyName: schemas.shortText(100).pipe(z.string().min(1, "is required")),
  companyEmail: schemas.email,
  adminName: schemas.personName,
  adminEmail: schemas.email,
  password: schemas.password,
  phone: optionalPhone,
});

router.post(
  "/register-company",
  limits.registerLimiter,
  (req, res, next) =>
    registrationEnabled()
      ? next()
      : res.status(403).json({
          message: "Self-service registration is disabled. Contact the administrator.",
          code: "REGISTRATION_DISABLED",
        }),
  validatePhoneField("phone"),
  validate({ body: registerSchema }),
  async (req, res) => {
    // Never log req.body here - it carries the admin's plaintext password.
    try {
      const { companyName, companyEmail, adminName, adminEmail, password, phone } =
        req.body;

      const existingCompany = await Company.findOne({
        $or: [{ name: companyName }, { email: companyEmail }],
      });
      if (existingCompany) {
        return res.status(400).json({ message: "Company already exists" });
      }

      const existingUser = await User.findOne({ email: adminEmail });
      if (existingUser) {
        return res.status(400).json({ message: "Email already registered" });
      }

      const company = new Company({ name: companyName, email: companyEmail, phone });
      await company.save();

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
        status: "active",
        isActive: true,
      });
      await admin.save();

      audit.record({
        req,
        actor: admin,
        company: company._id,
        action: "company.register",
        targetType: "company",
        targetId: company._id,
      });

      const tokens = await startSession(admin, req);
      res.status(201).json({
        message: "Company registered successfully",
        ...tokens,
        user: serializeAuthUser({ ...admin.toObject(), company }),
      });
    } catch (error) {
      console.error("Registration error:", error.message);
      if (error.name === "ValidationError") {
        return res.status(400).json({
          message: "Validation failed",
          errors: Object.values(error.errors).map((err) => err.message),
        });
      }
      if (error.code === 11000) {
        const field = Object.keys(error.keyValue || {})[0] || "value";
        return res.status(400).json({ message: `${field} already exists` });
      }
      res.status(500).json({ message: "Registration failed" });
    }
  }
);

/* ------------------------------------------------------------------ */
/*  Login                                                             */
/* ------------------------------------------------------------------ */
const loginSchema = z.object({
  email: z.string().trim().toLowerCase().min(1, "is required").max(254),
  password: schemas.anyPassword,
});

router.post(
  "/login",
  limits.loginIpLimiter,
  limits.loginAccountLimiter,
  validate({ body: loginSchema }),
  async (req, res) => {
    try {
      const { email, password } = req.body;

      const user = await User.findOne({ email })
        .select("+password")
        .populate("company");

      // Always run one bcrypt comparison, and answer every failure the same
      // way, so neither timing nor wording reveals whether the account exists,
      // is pending, or is deactivated.
      const passwordOk = user && user.password
        ? await user.comparePassword(password)
        : await bcrypt.compare(password, DUMMY_PASSWORD_HASH).then(() => false);

      const usable =
        user && passwordOk && user.isActive && user.status === "active" && user.company;

      if (!usable) {
        audit.record({
          req,
          actor: user || null,
          company: user ? user.company : null,
          action: "auth.login.failure",
          outcome: "failure",
          targetType: user ? "user" : undefined,
          targetId: user ? user._id : undefined,
          metadata: {
            reason: !user
              ? "unknown_account"
              : !passwordOk
              ? "bad_password"
              : "account_inactive",
          },
        });
        return res.status(401).json(INVALID_CREDENTIALS);
      }

      const tokens = await startSession(user, req);
      audit.record({ req, actor: user, action: "auth.login.success" });

      res.status(200).json({
        message: "Login successful",
        ...tokens,
        user: serializeAuthUser(user),
      });
    } catch (error) {
      console.error("Login error:", error.message);
      res.status(500).json({ message: "Login failed" });
    }
  }
);

/* ------------------------------------------------------------------ */
/*  Refresh / logout                                                   */
/* ------------------------------------------------------------------ */
const refreshSchema = z.object({ refreshToken: z.string().min(1).max(200) });

router.post(
  "/refresh",
  limits.refreshLimiter,
  validate({ body: refreshSchema }),
  async (req, res) => {
    try {
      const result = await sessions.rotateSession(req.body.refreshToken, req);

      // The session is only as good as the account behind it.
      const user = await User.findById(result.session.user).select("isActive status company");
      if (!user || !user.isActive || user.status !== "active") {
        await sessions.revokeSession(result.session._id, "account_inactive");
        return res.status(401).json({ message: "Session is no longer valid", code: "REFRESH_INVALID" });
      }

      res.status(200).json({
        token: result.token,
        refreshToken: result.refreshToken,
        expiresIn: result.expiresIn,
      });
    } catch (error) {
      if (error instanceof sessions.SessionError) {
        if (error.code === "REFRESH_REUSED") {
          audit.record({
            req,
            actor: { _id: error.userId, company: error.companyId },
            action: "auth.refresh.reuse_detected",
            outcome: "denied",
          });
        }
        return res.status(error.status).json({
          message:
            error.code === "REFRESH_RACE"
              ? "Session refresh already in progress"
              : "Session is no longer valid",
          code: error.code,
        });
      }
      console.error("Refresh error:", error.message);
      res.status(500).json({ message: "Could not refresh session" });
    }
  }
);

router.post("/logout", authenticateToken, async (req, res) => {
  try {
    await sessions.revokeSession(req.authSession._id, "logout");
    audit.record({ req, action: "auth.logout" });
    res.status(200).json({ message: "Signed out" });
  } catch (error) {
    console.error("Logout error:", error.message);
    res.status(500).json({ message: "Could not sign out" });
  }
});

router.post("/logout-all", authenticateToken, async (req, res) => {
  try {
    const count = await sessions.revokeAllForUser(req.user._id, "logout_all");
    audit.record({ req, action: "auth.logout_all", metadata: { sessions: count } });
    res.status(200).json({ message: "Signed out of all devices" });
  } catch (error) {
    console.error("Logout-all error:", error.message);
    res.status(500).json({ message: "Could not sign out" });
  }
});

/* ------------------------------------------------------------------ */
/*  Invitations                                                        */
/* ------------------------------------------------------------------ */

/**
 * An existing record is only re-invitable when it is a still-pending invite
 * in the SAME company. A pending user of another company must look exactly
 * like a registered one, or an admin elsewhere could pull that person (and
 * their future account) into their own tenant.
 */
const findReinvitable = async (email, companyId) => {
  const existing = await User.findOne({ email });
  if (!existing) return { existing: null, conflict: false };
  const sameCompany = String(existing.company) === String(companyId);
  if (existing.status !== "pending" || !sameCompany) {
    return { existing, conflict: true };
  }
  return { existing, conflict: false };
};

const inviteEmployeeSchema = z.object({
  name: schemas.personName,
  email: schemas.email,
  phone: optionalPhone,
  department: schemas.shortText(100).pipe(z.string().min(1, "is required")),
  position: schemas.shortText(100).pipe(z.string().min(1, "is required")),
  joinDate: schemas.isoDate,
  employeeId: z
    .string()
    .trim()
    .max(32)
    .regex(/^[A-Za-z0-9_-]*$/, "may only contain letters, numbers, - and _")
    .optional(),
});

router.post(
  "/invite-employee",
  authenticateToken,
  authorizeRoles("admin"),
  limits.inviteLimiter,
  validatePhoneField("phone"),
  validate({ body: inviteEmployeeSchema }),
  async (req, res) => {
    const startTime = Date.now();
    try {
      const { name, email, phone, department, position, joinDate } = req.body;
      const employeeId = req.body.employeeId || undefined;
      const companyId = req.user.company._id;

      const { existing: existingUser, conflict } = await findReinvitable(email, companyId);
      if (conflict) {
        return res.status(400).json({
          message: "Email already registered",
          hint: "This person has already accepted an invitation and has an active account.",
        });
      }
      const isResend = !!existingUser;

      if (employeeId) {
        const existingEmployee = await User.findOne({
          employeeId,
          ...(existingUser && { _id: { $ne: existingUser._id } }),
        });
        if (existingEmployee) {
          return res.status(400).json({ message: "Employee ID already exists" });
        }
      }

      let employee;
      if (isResend) {
        employee = existingUser;
        employee.name = name;
        employee.department = department;
        employee.position = position;
        employee.joinDate = new Date(joinDate);
        employee.invitedBy = req.user._id;
        employee.status = "pending";
        if (employeeId) employee.employeeId = employeeId;
        // Only overwrite a stored number when a new one was supplied, so a
        // resend does not wipe a number the employee set themselves.
        if (phone) employee.phone = phone;
      } else {
        employee = new User({
          name,
          email,
          role: "employee",
          department,
          position,
          joinDate: new Date(joinDate),
          company: companyId,
          invitedBy: req.user._id,
          status: "pending",
          ...(phone && { phone }),
          ...(employeeId && { employeeId }),
        });
      }

      // A fresh token invalidates any previous invitation link.
      const invitationToken = employee.generateInvitationToken();
      await employee.save();

      const emailQueue = require("../utils/emailQueue");
      const emailJobId = emailQueue.add(
        "INVITATION_EMAIL",
        {
          employee: { ...employee.toObject(), company: req.user.company.name },
          token: invitationToken,
          inviterName: req.user.name,
          role: "employee",
          // Surfaced (to this admin only) if delivery fails, so the invite can
          // be passed on by hand instead of being reported as sent.
          fallbackUrl: `${
            process.env.FRONTEND_URL || "http://localhost:3000"
          }/verify-invitation/${invitationToken}`,
        },
        "high",
        { companyId, createdBy: req.user._id }
      );

      audit.record({
        req,
        action: isResend ? "user.invite.resend" : "user.invite",
        targetType: "user",
        targetId: employee._id,
        metadata: { role: "employee" },
      });

      const totalTime = Date.now() - startTime;
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
        emailJobId,
        processingTime: totalTime,
        note: "Employee saved. Email delivery is still in progress - poll email-queue/job/:id for the result.",
      });
    } catch (error) {
      console.error("Invite route error:", error.message);
      if (error.name === "ValidationError") {
        return res.status(400).json({
          message: "Validation failed",
          errors: Object.values(error.errors).map((err) => err.message),
        });
      }
      res.status(500).json({ message: "Failed to invite employee" });
    }
  }
);

const inviteAdminSchema = z.object({
  name: schemas.personName,
  email: schemas.email,
  phone: optionalPhone,
  department: schemas.shortText(100).optional(),
  position: schemas.shortText(100).optional(),
  employeeId: z.string().max(32).optional(),
});

router.post(
  "/invite-admin",
  authenticateToken,
  authorizeRoles("admin"),
  limits.inviteLimiter,
  validatePhoneField("phone"),
  validate({ body: inviteAdminSchema }),
  async (req, res) => {
    try {
      const { name, email, phone } = req.body;
      const department = req.body.department || "Administration";
      const position = req.body.position || "Administrator";
      const companyId = req.user.company._id;

      const { existing: existingUser, conflict } = await findReinvitable(email, companyId);
      if (conflict) {
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
        admin.invitedBy = req.user._id;
        admin.status = "pending";
        if (phone) admin.phone = phone;
      } else {
        admin = new User({
          name,
          email,
          role: "admin",
          department,
          position,
          joinDate: new Date(),
          company: companyId,
          invitedBy: req.user._id,
          status: "pending",
          ...(phone && { phone }),
        });
      }

      const invitationToken = admin.generateInvitationToken();
      await admin.save();

      audit.record({
        req,
        action: isResend ? "user.invite.resend" : "user.invite",
        targetType: "user",
        targetId: admin._id,
        metadata: { role: "admin" },
      });

      const adminSummary = {
        id: admin._id,
        name: admin.name,
        email: admin.email,
        employeeId: admin.employeeId,
        department: admin.department,
        position: admin.position,
        status: admin.status,
      };

      const { sendInvitationEmail } = require("../utils/email");
      try {
        await sendInvitationEmail(
          { ...admin.toObject(), company: req.user.company.name },
          invitationToken,
          req.user.name,
          "admin"
        );
        res.status(201).json({ message: "Admin invitation sent successfully", admin: adminSummary });
      } catch (emailError) {
        console.error("Admin email sending error:", emailError.message);
        // The inviting admin gets the link to pass on by hand; it is returned
        // only to them, in this response, and never logged.
        return res.status(201).json({
          message:
            "Admin invitation created successfully, but email delivery failed. Please share the invitation link manually.",
          warning: "Email delivery failed",
          admin: adminSummary,
          invitationToken,
          manualInviteUrl: `${
            process.env.FRONTEND_URL || "http://localhost:3000"
          }/verify-invitation/${invitationToken}`,
        });
      }
    } catch (error) {
      console.error("Invite admin error:", error.message);
      res.status(500).json({ message: "Failed to invite admin" });
    }
  }
);

/* ------------------------------------------------------------------ */
/*  Profile                                                            */
/* ------------------------------------------------------------------ */
router.get("/profile", authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user._id).populate("company");
    res.status(200).json({ user: serializeAuthUser(user) });
  } catch (error) {
    res.status(500).json({ message: "Failed to get profile" });
  }
});

/* ------------------------------------------------------------------ */
/*  Invitation acceptance                                              */
/* ------------------------------------------------------------------ */
const tokenParams = z.object({ token: schemas.token });

router.post(
  "/verify-invitation/:token",
  limits.tokenLinkLimiter,
  validate({ params: tokenParams, body: z.object({ password: schemas.password }) }),
  async (req, res) => {
    try {
      const user = await User.findOne({
        invitationToken: sha256(req.params.token),
        invitationExpires: { $gt: Date.now() },
      }).populate("company");

      if (!user) {
        return res.status(400).json({ message: "Invalid or expired invitation token" });
      }

      user.password = req.body.password;
      user.status = "active";
      // Single use: the token is gone once it has been redeemed.
      user.invitationToken = undefined;
      user.invitationExpires = undefined;
      await user.save();

      audit.record({ req, actor: user, action: "auth.invitation.accepted" });

      const tokens = await startSession(user, req);

      // Admin notifications are sent after responding; a slow mail provider
      // must not hold up (or fail) the new user's first sign-in.
      setImmediate(async () => {
        try {
          const { sendEmployeeJoinedNotification } = require("../utils/email");
          const admins = await User.find({
            company: user.company._id,
            role: "admin",
            status: "active",
          });
          await Promise.allSettled(
            admins.map((admin) => sendEmployeeJoinedNotification(admin, user))
          );
        } catch (notifyError) {
          console.error("Employee joined notification failed:", notifyError.message);
        }
      });

      res.status(200).json({
        message: "Account verified successfully",
        ...tokens,
        user: serializeAuthUser(user),
      });
    } catch (error) {
      console.error("Verification error:", error.message);
      res.status(500).json({ message: "Failed to verify invitation" });
    }
  }
);

router.get(
  "/invitation/:token",
  limits.tokenLinkLimiter,
  validate({ params: tokenParams }),
  async (req, res) => {
    try {
      const user = await User.findOne({
        invitationToken: sha256(req.params.token),
        invitationExpires: { $gt: Date.now() },
      })
        .populate("company")
        .populate("invitedBy", "name");

      if (!user) {
        return res.status(400).json({ message: "Invalid or expired invitation token" });
      }

      res.status(200).json({
        user: {
          name: user.name,
          email: user.email,
          role: user.role,
          department: user.department,
          position: user.position,
          company: user.company ? user.company.name : "",
          invitedBy: user.invitedBy ? user.invitedBy.name : "",
        },
      });
    } catch (error) {
      console.error("Get invitation error:", error.message);
      res.status(500).json({ message: "Failed to get invitation details" });
    }
  }
);

/* ------------------------------------------------------------------ */
/*  Password reset                                                     */
/* ------------------------------------------------------------------ */
const RESET_ACCEPTED = {
  message:
    "If an account exists with that email, you will receive a password reset link shortly.",
};

router.post(
  "/forgot-password",
  limits.passwordResetIpLimiter,
  limits.passwordResetAccountLimiter,
  validate({ body: z.object({ email: z.string().trim().toLowerCase().min(1).max(254) }) }),
  async (req, res) => {
    // Same response, and the same timing, whether or not the account exists:
    // the lookup and the email are handled after responding.
    res.status(200).json(RESET_ACCEPTED);

    const { email } = req.body;
    setImmediate(async () => {
      try {
        const user = await User.findOne({ email, status: "active", isActive: true }).populate(
          "company"
        );
        if (!user) return;

        const resetToken = user.generatePasswordResetToken();
        await user.save({ validateBeforeSave: false });

        audit.record({
          req,
          actor: user,
          action: "auth.password.reset_requested",
        });

        const { sendPasswordResetEmail } = require("../utils/email");
        await sendPasswordResetEmail(
          { ...user.toObject(), company: user.company ? user.company.name : "" },
          resetToken
        );
      } catch (error) {
        console.error("Forgot password processing error:", error.message);
      }
    });
  }
);

router.post(
  "/reset-password/:token",
  limits.tokenLinkLimiter,
  validate({ params: tokenParams, body: z.object({ password: schemas.password }) }),
  async (req, res) => {
    try {
      const user = await User.findOne({
        passwordResetToken: sha256(req.params.token),
        passwordResetExpires: { $gt: Date.now() },
      });

      if (!user) {
        return res.status(400).json({ message: "Invalid or expired password reset token" });
      }

      user.password = req.body.password;
      // Single use.
      user.passwordResetToken = undefined;
      user.passwordResetExpires = undefined;
      await user.save();

      // Whoever might have had access before the reset loses it now.
      await sessions.revokeAllForUser(user._id, "password_reset");
      audit.record({ req, actor: user, action: "auth.password.reset" });

      setImmediate(() => {
        User.findById(user._id)
          .populate("company")
          .then((fresh) => {
            if (!fresh) return;
            const { sendPasswordChangedEmail } = require("../utils/email");
            return sendPasswordChangedEmail({
              ...fresh.toObject(),
              company: fresh.company ? fresh.company.name : "",
            });
          })
          .catch((e) => console.error("Password changed email failed:", e.message));
      });

      res.status(200).json({
        message: "Password reset successfully. You can now log in with your new password.",
      });
    } catch (error) {
      console.error("Reset password error:", error.message);
      res.status(500).json({ message: "Failed to reset password" });
    }
  }
);

router.get(
  "/reset-password/:token",
  limits.tokenLinkLimiter,
  validate({ params: tokenParams }),
  async (req, res) => {
    try {
      const user = await User.findOne({
        passwordResetToken: sha256(req.params.token),
        passwordResetExpires: { $gt: Date.now() },
      }).select("name email");

      if (!user) {
        return res.status(400).json({ message: "Invalid or expired password reset token" });
      }

      res.status(200).json({ valid: true, user: { name: user.name, email: user.email } });
    } catch (error) {
      console.error("Validate reset token error:", error.message);
      res.status(500).json({ message: "Failed to validate reset token" });
    }
  }
);

/* ------------------------------------------------------------------ */
/*  Change password (signed in)                                        */
/* ------------------------------------------------------------------ */
router.put(
  "/change-password",
  authenticateToken,
  limits.changePasswordLimiter,
  validate({
    body: z.object({ currentPassword: schemas.anyPassword, newPassword: schemas.password }),
  }),
  async (req, res) => {
    try {
      const { currentPassword, newPassword } = req.body;
      const user = await User.findById(req.user._id).select("+password");

      if (!(await user.comparePassword(currentPassword))) {
        audit.record({ req, action: "auth.password.change", outcome: "failure" });
        return res.status(400).json({ message: "Current password is incorrect" });
      }

      user.password = newPassword;
      await user.save();

      // Every other device is signed out; this one stays signed in.
      await sessions.revokeAllForUser(user._id, "password_change", req.authSession._id);
      audit.record({ req, action: "auth.password.change" });

      setImmediate(() => {
        const { sendPasswordChangedEmail } = require("../utils/email");
        sendPasswordChangedEmail({
          ...user.toObject(),
          company: req.user.company ? req.user.company.name : "",
        }).catch((e) => console.error("Password changed email failed:", e.message));
      });

      res.status(200).json({ message: "Password changed successfully" });
    } catch (error) {
      console.error("Change password error:", error.message);
      res.status(500).json({ message: "Failed to change password" });
    }
  }
);

/* ------------------------------------------------------------------ */
/*  Leave quota (admin)                                                */
/* ------------------------------------------------------------------ */
const quotaDays = z.number().int().min(0).max(366);
const leaveQuotaSchema = z.object({
  leaveQuota: z
    .object({
      annual: quotaDays.optional(),
      sick: quotaDays.optional(),
      casual: quotaDays.optional(),
      maternity: quotaDays.optional(),
      paternity: quotaDays.optional(),
      emergency: quotaDays.optional(),
    })
    .strict(),
});

router.put(
  "/leave-quota/:employeeId",
  authenticateToken,
  authorizeRoles("admin"),
  validate({ params: z.object({ employeeId: schemas.objectId }), body: leaveQuotaSchema }),
  async (req, res) => {
    try {
      const employee = await User.findOne({
        _id: req.params.employeeId,
        company: req.user.company._id,
      });
      if (!employee) {
        return res.status(404).json({ message: "Employee not found" });
      }

      const before = { ...(employee.leaveQuota?.toObject?.() || employee.leaveQuota) };
      employee.leaveQuota = { ...before, ...req.body.leaveQuota };
      await employee.save();

      audit.record({
        req,
        action: "leave.quota.update",
        targetType: "user",
        targetId: employee._id,
        metadata: { changed: req.body.leaveQuota },
      });

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
      console.error("Update leave quota error:", error.message);
      res.status(500).json({ message: "Failed to update leave quota" });
    }
  }
);

/* ------------------------------------------------------------------ */
/*  Leave balance                                                      */
/* ------------------------------------------------------------------ */
router.get(
  "/leave-balance/:employeeId?",
  authenticateToken,
  validate({ params: z.object({ employeeId: schemas.objectId.optional() }) }),
  async (req, res) => {
    try {
      const { employeeId } = req.params;
      let targetUserId = req.user._id;

      // Admins may look up anyone in their company; everyone else gets their own.
      if (employeeId && req.user.role === "admin") {
        const employee = await User.findOne({
          _id: employeeId,
          company: req.user.company._id,
        });
        if (!employee) {
          return res.status(404).json({ message: "Employee not found" });
        }
        targetUserId = employee._id;
      }

      const user = await User.findById(targetUserId);
      const leaveBalances = await user.getAllLeaveBalances();

      res.status(200).json({ employeeId: targetUserId, name: user.name, leaveBalances });
    } catch (error) {
      console.error("Get leave balance error:", error.message);
      res.status(500).json({ message: "Failed to get leave balance" });
    }
  }
);

/* ------------------------------------------------------------------ */
/*  Email queue (admin, own company only)                              */
/* ------------------------------------------------------------------ */
router.get("/email-queue/status", authenticateToken, authorizeRoles("admin"), (req, res) => {
  const emailQueue = require("../utils/emailQueue");
  const status = emailQueue.getStatus({
    companyId: req.user.company._id,
    viewerId: req.user._id,
  });
  res.status(200).json({
    message: "Email queue status retrieved successfully",
    ...status,
    timestamp: new Date().toISOString(),
  });
});

router.get(
  "/email-queue/job/:jobId",
  authenticateToken,
  authorizeRoles("admin"),
  validate({ params: z.object({ jobId: z.string().regex(/^job_\d{1,12}$/) }) }),
  (req, res) => {
    const emailQueue = require("../utils/emailQueue");
    const job = emailQueue.getJob(req.params.jobId, {
      companyId: req.user.company._id,
      viewerId: req.user._id,
    });
    if (!job) {
      return res.status(404).json({ message: "Email job not found" });
    }
    res.status(200).json({
      message: "Email job status retrieved successfully",
      job,
      timestamp: new Date().toISOString(),
    });
  }
);

module.exports = router;
