const mongoose = require("mongoose");

/**
 * One signed-in device.
 *
 * The refresh token is never stored, only its SHA-256 hash, so a database read
 * does not yield a usable credential. The previous hash is kept for one
 * rotation so that a replayed (stolen) refresh token can be told apart from a
 * legitimate one and the whole session revoked.
 */
const sessionSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    company: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
    },
    refreshTokenHash: { type: String, required: true, select: false },
    previousRefreshTokenHash: { type: String, select: false },
    rotatedAt: { type: Date },
    lastUsedAt: { type: Date, default: Date.now },
    // Idle expiry: pushed forward on every refresh, never past absoluteExpiresAt.
    expiresAt: { type: Date, required: true },
    absoluteExpiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
    revokedReason: { type: String, maxlength: 64 },
    userAgent: { type: String, maxlength: 200 },
    ip: { type: String, maxlength: 64 },
  },
  { timestamps: true }
);

// Expired sessions are removed by MongoDB itself once past their hard limit.
sessionSchema.index({ absoluteExpiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model("Session", sessionSchema);
