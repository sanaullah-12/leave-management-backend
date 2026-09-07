/**
 * AppRelease Model
 * ----------------
 * Which versions of Nexora have already been announced to the people using it.
 *
 * The collection exists for one reason: an announcement must happen once per
 * release, not once per process start. A deployed backend restarts for all
 * sorts of reasons - a crash, a scale event, a platform migration - and none of
 * them are news. Recording the announced version makes the check "is this
 * version new to the database" rather than "is this process new", which is the
 * only version of the question that survives more than one instance.
 *
 * The unique index on `version` is what makes it safe under concurrency: two
 * instances booting at once both try to insert, one wins, and the loser learns
 * from the duplicate-key error that somebody else has already told everyone.
 */

const mongoose = require("mongoose");

const appReleaseSchema = new mongoose.Schema(
  {
    /** The version string that was announced, e.g. "1.4.0". */
    version: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },

    /** Optional human summary of what changed, shown in the notification. */
    notes: {
      type: String,
      default: null,
    },

    announcedAt: {
      type: Date,
      default: Date.now,
    },

    /**
     * Who announced it. Null for the automatic announcement on boot, which is
     * the normal case - a release is not a person's action.
     */
    announcedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    /** How many people were notified, for the admin view and for support. */
    recipientCount: {
      type: Number,
      default: 0,
    },
  },
  {
    timestamps: true,
    collection: "appreleases",
  }
);

/**
 * Claim a version for announcement.
 *
 * Returns the created document, or null when this version has already been
 * announced. The insert itself is the lock: the unique index means only one
 * caller can ever create a given version, so two instances racing on boot
 * produce exactly one announcement between them.
 */
appReleaseSchema.statics.claim = async function ({ version, notes, announcedBy }) {
  try {
    return await this.create({
      version,
      notes: notes || null,
      announcedBy: announcedBy || null,
      announcedAt: new Date(),
    });
  } catch (error) {
    // 11000 means another instance got there first, which is a success for the
    // thing the caller actually wanted: everyone has been told, once.
    if (error?.code === 11000) return null;
    throw error;
  }
};

/** The most recently announced release, or null on a fresh install. */
appReleaseSchema.statics.latest = function () {
  return this.findOne().sort({ announcedAt: -1 }).lean();
};

module.exports = mongoose.model("AppRelease", appReleaseSchema);
