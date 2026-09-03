const mongoose = require("mongoose");

/**
 * WorkFromHome - a request to work a day, or a run of days, away from the
 * office.
 *
 * Deliberately a sibling of Leave rather than a leave type. A WFH day is a
 * working day: it must never touch a leave balance, and the two answer
 * different questions ("were you working?" vs "were you away?"). Keeping them
 * apart is what makes requirement 7 structural rather than a rule someone has
 * to remember.
 *
 * Shape mirrors Leave on purpose - same tenant scoping, same review fields,
 * same status vocabulary - so the existing list, review and notification
 * patterns apply unchanged.
 *
 * Room left for later, without a migration:
 *   - `dayCount` is stored, so half-days or a per-day breakdown can refine it
 *   - `workMode` names the mode this request grants, so hybrid schedules can
 *     add "hybrid" or "client_site" without a second model
 *   - `metadata` carries policy snapshots, recurrence rules and analytics tags
 */
const workFromHomeSchema = new mongoose.Schema(
  {
    employee: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: [true, "A WFH request must belong to an employee"],
    },
    company: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: [true, "A WFH request must belong to a company"],
    },
    startDate: {
      type: Date,
      required: [true, "Please provide a start date"],
    },
    endDate: {
      type: Date,
      required: [true, "Please provide an end date"],
    },
    /** Calendar days covered, inclusive. Set in the pre-save hook. */
    totalDays: {
      type: Number,
      required: false,
    },
    reason: {
      type: String,
      required: [true, "Please provide a reason"],
      trim: true,
      maxlength: [500, "Reason cannot exceed 500 characters"],
    },
    /** Optional free-text the employee adds for context. */
    note: {
      type: String,
      trim: true,
      maxlength: [1000, "Note cannot exceed 1000 characters"],
      default: "",
    },
    /**
     * What an approved request grants. One value today; the field exists so a
     * hybrid or client-site mode is a new enum entry rather than a new model.
     */
    workMode: {
      type: String,
      enum: ["work_from_home"],
      default: "work_from_home",
    },
    status: {
      type: String,
      enum: ["pending", "approved", "rejected", "cancelled"],
      default: "pending",
    },
    /**
     * True when the request was raised for days that had already passed.
     *
     * A reviewer is doing something different in that case - correcting the
     * record rather than granting permission - so the queue says which it is
     * instead of leaving them to compare dates.
     */
    isBackdated: {
      type: Boolean,
      default: false,
    },
    appliedDate: {
      type: Date,
      default: Date.now,
    },
    reviewedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    reviewedDate: {
      type: Date,
    },
    reviewComments: {
      type: String,
      trim: true,
      maxlength: [500, "Review comments cannot exceed 500 characters"],
    },
    /**
     * Open bag for features that are not V1: policy snapshots, recurrence
     * rules, hybrid schedule ids, analytics tags. Untyped on purpose - a
     * schema change here would otherwise be required for every one of them.
     */
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  { timestamps: true }
);

/**
 * Inclusive day count, and never less than one.
 *
 * Counted between calendar days rather than timestamps: a range stored as
 * midnight-to-end-of-day is 47:59:59 long, which rounds to an extra day and
 * turns a two-day request into three.
 */
workFromHomeSchema.pre("save", function (next) {
  if (this.startDate && this.endDate) {
    const utcDay = (date) =>
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
    const days =
      Math.round((utcDay(this.endDate) - utcDay(this.startDate)) / 86400000) + 1;
    this.totalDays = days > 0 ? days : 1;
  }
  if (!this.totalDays || this.totalDays < 1) this.totalDays = 1;
  next();
});

workFromHomeSchema.pre("save", function (next) {
  if (this.endDate < this.startDate) {
    return next(new Error("End date must be on or after the start date"));
  }
  next();
});

// The read paths: an employee's own requests, an admin's company queue, and
// the date-range scan the work-mode resolver runs for every attendance read.
workFromHomeSchema.index({ employee: 1, status: 1, startDate: -1 });
workFromHomeSchema.index({ company: 1, status: 1, startDate: -1 });
workFromHomeSchema.index({ company: 1, status: 1, startDate: 1, endDate: 1 });

module.exports = mongoose.model("WorkFromHome", workFromHomeSchema);
