const mongoose = require("mongoose");

/**
 * AttendanceCorrection - an employee's request to have one day's arrival read
 * at a different time from the one the device recorded.
 *
 * The device punch is never edited. It stays in `attendancelogs` exactly as the
 * agent delivered it, and `machineCheckIn` below keeps a copy of the arrival
 * the request was raised against. An approved correction is an overlay: every
 * attendance read asks services/attendanceCorrectionService for the effective
 * arrival of an employee-day, and that is where the approved time replaces the
 * machine time. Nothing is copied into a second place, so there is nothing to
 * fall out of step.
 *
 * A correction can only move an arrival earlier. Its purpose is to excuse a
 * late arrival the office already knew about, not to make a day later.
 */
const STATUSES = ["pending", "approved", "rejected", "cancelled"];

/** Statuses that still claim the day. At most one per employee-day. */
const ACTIVE_STATUSES = ["pending", "approved"];

const attendanceCorrectionSchema = new mongoose.Schema(
  {
    company: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: [true, "A correction must belong to a company"],
      index: true,
    },
    employee: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: [true, "A correction must belong to an employee"],
      index: true,
    },
    /** The device code the punches are filed under. Snapshot at request time. */
    employeeCode: {
      type: String,
      required: true,
      trim: true,
    },
    /** The office calendar day being corrected. YYYY-MM-DD. */
    date: {
      type: String,
      required: true,
      match: [/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD"],
    },
    /** The first device punch of the day, as it stood when the request was raised. */
    machineCheckIn: {
      type: Date,
      required: true,
    },
    /** The arrival the employee asks to be judged by, as office wall-clock "HH:MM". */
    requestedTime: {
      type: String,
      required: true,
      match: [/^([01]\d|2[0-3]):[0-5]\d$/, "Requested time must be HH:MM"],
    },
    /** requestedTime on `date`, as an instant in the office timezone. */
    requestedCheckIn: {
      type: Date,
      required: true,
    },
    reason: {
      type: String,
      required: [true, "Please provide a reason"],
      trim: true,
      maxlength: [500, "Reason cannot exceed 500 characters"],
    },
    /** The rule the machine arrival was judged late under, for the reviewer. */
    judgedAgainst: {
      cutoffTime: { type: String, default: "" },
      lateMinutes: { type: Number, default: 0 },
    },
    status: {
      type: String,
      enum: STATUSES,
      default: "pending",
      index: true,
    },
    /**
     * True while the request claims its day (pending or approved). Kept as its
     * own field so the one-per-day rule is a plain partial unique index that
     * every MongoDB version can build.
     */
    active: {
      type: Boolean,
      default: true,
    },
    reviewedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    reviewedAt: {
      type: Date,
      default: null,
    },
    reviewComments: {
      type: String,
      trim: true,
      maxlength: [500, "Comments cannot exceed 500 characters"],
      default: "",
    },
  },
  { timestamps: true }
);

attendanceCorrectionSchema.pre("validate", function syncActive(next) {
  this.active = ACTIVE_STATUSES.includes(this.status);
  next();
});

// One live request per employee-day. A rejected or cancelled one frees the day
// for a new request; the old document stays as history.
attendanceCorrectionSchema.index(
  { company: 1, employeeCode: 1, date: 1 },
  { unique: true, partialFilterExpression: { active: true } }
);

// The read every attendance screen makes: approved corrections over a range.
attendanceCorrectionSchema.index({ status: 1, date: 1, employeeCode: 1 });
attendanceCorrectionSchema.index({ company: 1, status: 1, createdAt: -1 });

attendanceCorrectionSchema.statics.STATUSES = STATUSES;
attendanceCorrectionSchema.statics.ACTIVE_STATUSES = ACTIVE_STATUSES;

module.exports = mongoose.model(
  "AttendanceCorrection",
  attendanceCorrectionSchema
);
