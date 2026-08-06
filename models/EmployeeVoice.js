const mongoose = require("mongoose");

/**
 * EmployeeVoice - a secure communication record raised by an employee
 * (workplace issue, complaint, suggestion, HR support, appreciation or feedback).
 * Mirrors the Leave model's company/employee tenant-scoping and attachment shape.
 */
const replySchema = new mongoose.Schema(
  {
    author: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    authorName: { type: String, required: true },
    authorRole: {
      type: String,
      enum: ["admin", "employee"],
      required: true,
    },
    message: {
      type: String,
      required: true,
      trim: true,
      maxlength: [2000, "Reply cannot exceed 2000 characters"],
    },
  },
  { timestamps: true }
);

const employeeVoiceSchema = new mongoose.Schema(
  {
    employee: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: [true, "Employee voice must belong to an employee"],
    },
    company: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: [true, "Employee voice must belong to a company"],
    },
    category: {
      type: String,
      required: [true, "Please choose a category"],
      enum: {
        values: [
          "workplace_issue",
          "complaint",
          "suggestion",
          "hr_support",
          "appreciation",
          "feedback",
        ],
        message: "Invalid category",
      },
    },
    title: {
      type: String,
      required: [true, "Please provide a title"],
      trim: true,
      maxlength: [140, "Title cannot exceed 140 characters"],
    },
    description: {
      type: String,
      required: [true, "Please provide a description"],
      trim: true,
      maxlength: [4000, "Description cannot exceed 4000 characters"],
    },
    priority: {
      type: String,
      enum: ["low", "medium", "high", "urgent"],
      default: "medium",
    },
    department: {
      type: String,
      trim: true,
    },
    // When true the submitter's identity is hidden from admins in the UI.
    isAnonymous: {
      type: Boolean,
      default: false,
    },
    status: {
      type: String,
      enum: [
        "pending",
        "under_review",
        "in_progress",
        "waiting_employee",
        "resolved",
        "closed",
      ],
      default: "pending",
    },
    attachments: [
      {
        filename: String,
        originalName: String,
        mimetype: String,
        size: Number,
        path: String,
      },
    ],
    replies: [replySchema],
    reviewedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    reviewedDate: {
      type: Date,
    },
    resolvedDate: {
      type: Date,
    },
  },
  { timestamps: true }
);

// Query performance - mirrors the Leave model indexes.
employeeVoiceSchema.index({ company: 1, status: 1 });
employeeVoiceSchema.index({ employee: 1, status: 1 });
employeeVoiceSchema.index({ company: 1, createdAt: -1 });

module.exports = mongoose.model("EmployeeVoice", employeeVoiceSchema);
