const mongoose = require("mongoose");

/**
 * Announcement - a company notice-board post authored by HR/admin and visible
 * to the whole company (or admins only). Tenant-scoped by `company`, mirroring
 * the Leave / EmployeeVoice models. Tracks read receipts and lightweight emoji
 * reactions so the board feels alive.
 */
const reactionSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    emoji: { type: String, required: true },
  },
  { _id: false, timestamps: false }
);

const announcementSchema = new mongoose.Schema(
  {
    company: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: [true, "Announcement must belong to a company"],
    },
    author: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: [true, "Announcement must have an author"],
    },
    authorName: { type: String, required: true },
    title: {
      type: String,
      required: [true, "Please provide a title"],
      trim: true,
      maxlength: [160, "Title cannot exceed 160 characters"],
    },
    body: {
      type: String,
      required: [true, "Please provide the announcement content"],
      trim: true,
      maxlength: [8000, "Content cannot exceed 8000 characters"],
    },
    category: {
      type: String,
      enum: {
        values: [
          "general",
          "event",
          "policy",
          "celebration",
          "update",
          "urgent",
        ],
        message: "Invalid category",
      },
      default: "general",
    },
    // Who the notice is for. "all" = everyone in the company; "admins" = HR only.
    audience: {
      type: String,
      enum: ["all", "admins"],
      default: "all",
    },
    pinned: { type: Boolean, default: false },
    // Optional auto-expiry - expired notices are hidden from the board.
    expiresAt: { type: Date },
    reads: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
    reactions: [reactionSchema],
  },
  { timestamps: true }
);

// Query performance - board is read pinned-first, newest-first, per company.
announcementSchema.index({ company: 1, pinned: -1, createdAt: -1 });
announcementSchema.index({ company: 1, category: 1 });

module.exports = mongoose.model("Announcement", announcementSchema);
