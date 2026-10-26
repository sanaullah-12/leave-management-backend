const mongoose = require("mongoose");

/**
 * AbsenceRuleRun - where the unreported absence rule stands on one company-day.
 *
 * The rule refuses to judge a day while no attendance has arrived for it (the
 * feed is down, not the whole office away). That refusal is recorded here as
 * `awaiting_attendance`, and the scheduler comes back to exactly those days
 * once the agent delivers the punches, judging them on real attendance.
 *
 * Only days the rule itself set aside are ever revisited. Re-running days in
 * general would charge again any auto-marked leave an admin had removed.
 */
const STATUSES = ["awaiting_attendance", "judged"];

const absenceRuleRunSchema = new mongoose.Schema(
  {
    company: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true,
    },
    /** Office-local calendar day, YYYY-MM-DD. */
    date: {
      type: String,
      required: true,
      match: /^\d{4}-\d{2}-\d{2}$/,
    },
    status: {
      type: String,
      enum: STATUSES,
      required: true,
    },
    judgedAt: Date,
    /** How many days were recorded as leave when the day was judged. */
    marked: {
      type: Number,
      default: 0,
    },
    /** True when the day was judged after the fact, once attendance arrived. */
    catchUp: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

absenceRuleRunSchema.index({ company: 1, date: 1 }, { unique: true });
absenceRuleRunSchema.index({ status: 1, date: 1 });

module.exports = mongoose.model("AbsenceRuleRun", absenceRuleRunSchema);
module.exports.STATUSES = STATUSES;
