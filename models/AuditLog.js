const mongoose = require("mongoose");

/**
 * Security audit trail.
 *
 * Append-only: every update and delete path through Mongoose throws, so
 * application code cannot rewrite history. Each entry also carries the hash of
 * the previous entry for the same company (a hash chain), so an edit made
 * directly in the database breaks the chain and is detected by
 * GET /api/audit-logs/verify.
 *
 * Never store passwords, tokens or secrets here. services/auditLog.js strips
 * such keys from `metadata` before writing.
 */
const auditLogSchema = new mongoose.Schema(
  {
    company: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      default: null,
      index: true,
    },
    actor: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    actorRole: { type: String, maxlength: 32 },
    action: { type: String, required: true, maxlength: 64, index: true },
    outcome: {
      type: String,
      enum: ["success", "failure", "denied"],
      default: "success",
    },
    targetType: { type: String, maxlength: 32 },
    targetId: { type: String, maxlength: 64 },
    metadata: { type: mongoose.Schema.Types.Mixed },
    ip: { type: String, maxlength: 64 },
    userAgent: { type: String, maxlength: 200 },
    prevHash: { type: String, required: true },
    hash: { type: String, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

auditLogSchema.index({ company: 1, createdAt: -1 });

const immutable = function (next) {
  next(new Error("Audit log entries are append-only"));
};

auditLogSchema.pre("save", function (next) {
  if (!this.isNew) return immutable(next);
  next();
});

[
  "updateOne",
  "updateMany",
  "findOneAndUpdate",
  "replaceOne",
  "findOneAndReplace",
  "deleteOne",
  "deleteMany",
  "findOneAndDelete",
].forEach((op) => {
  auditLogSchema.pre(op, { document: false, query: true }, immutable);
});
auditLogSchema.pre("deleteOne", { document: true, query: false }, immutable);

module.exports = mongoose.model("AuditLog", auditLogSchema);
