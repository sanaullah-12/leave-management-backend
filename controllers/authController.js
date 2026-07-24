const User = require("../models/User");
const jwt = require("jsonwebtoken");
const nodemailer = require("nodemailer");

// @desc    Invite user
// @route   POST /api/auth/invite
// @access  Private/Admin
const inviteUser = async (req, res) => {
  // ...existing code...

  // Before: const inviteLink = `https://leave-management-app.vercel.app/register?token=${inviteToken}`;
  // After: Dynamic URL from environment
  const inviteLink = `${process.env.FRONTEND_URL}/register?token=${inviteToken}`;

  // ...existing code...
};

// ...existing code...
