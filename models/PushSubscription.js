/**
 * PushSubscription Model
 * ----------------------
 * One browser's permission to be pushed to, owned by one user.
 *
 * A subscription is per browser profile, not per person: the same employee on a
 * phone, a work laptop and a home desktop is three documents, and pushing to
 * them all is what "notify me even when the tab is closed" means. The endpoint
 * is the browser's own push-service URL and is what makes a subscription
 * unique, so re-subscribing on the same browser updates a row rather than
 * accumulating dead ones.
 *
 * Deliberately its own collection with no reference from anything else. Push
 * transport is not business data: an employee revoking permission, changing
 * browser or clearing site data must never affect a leave, an attendance record
 * or a stored Notification. The Notification collection remains the history;
 * this is only how a copy reaches the device.
 *
 * The keys are the browser's public encryption material (p256dh) and an auth
 * secret. They are useless without the server's VAPID private key, which lives
 * in the environment and never touches the database.
 */

const mongoose = require("mongoose");

const pushSubscriptionSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    // Denormalised so a company-wide push can be resolved without joining back
    // through User, and so a tenant's rows can be removed as a unit.
    company: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true,
      index: true,
    },

    /** The push service URL this browser gave us. Unique per browser profile. */
    endpoint: {
      type: String,
      required: true,
      unique: true,
    },

    keys: {
      p256dh: { type: String, required: true },
      auth: { type: String, required: true },
    },

    /**
     * Only for telling one device from another in a "your devices" list.
     * Never parsed for behaviour - a user agent string is a poor identifier and
     * a worse basis for a decision.
     */
    userAgent: {
      type: String,
      default: null,
    },

    /**
     * Refreshed every time the browser re-registers. A subscription the browser
     * has stopped confirming is one whose owner has moved on, which is what
     * makes pruning safe.
     */
    lastSeenAt: {
      type: Date,
      default: Date.now,
    },

    lastPushAt: {
      type: Date,
      default: null,
    },

    /**
     * Consecutive delivery failures that were not outright rejections.
     *
     * A 404/410 from the push service is definitive and deletes the row
     * immediately. Anything else - a timeout, a 500 at the push service - is
     * transient, and deleting on the first one would unsubscribe people because
     * Google had a bad minute.
     */
    failureCount: {
      type: Number,
      default: 0,
    },
  },
  {
    timestamps: true,
    collection: "pushsubscriptions",
  }
);

// The read this collection exists to serve: "every device belonging to this
// user". Compound with company so a tenant-scoped push does not scan.
pushSubscriptionSchema.index({ user: 1, company: 1 });

/**
 * Record a browser's subscription, replacing whatever was at that endpoint.
 *
 * Upsert rather than insert because the same browser re-registers routinely -
 * on every login, and whenever the push service rotates its endpoint. Keying on
 * the endpoint also re-homes a subscription when a different person logs into
 * the same browser, which is the correct outcome: the previous owner is no
 * longer the one sitting there.
 */
pushSubscriptionSchema.statics.register = async function ({
  user,
  company,
  endpoint,
  keys,
  userAgent,
}) {
  return this.findOneAndUpdate(
    { endpoint },
    {
      $set: {
        user,
        company,
        endpoint,
        keys,
        userAgent: userAgent || null,
        lastSeenAt: new Date(),
        failureCount: 0,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
};

/** Every live subscription for a user. */
pushSubscriptionSchema.statics.forUser = function (userId) {
  return this.find({ user: userId }).lean();
};

/**
 * Drop one endpoint.
 *
 * Used both by an explicit unsubscribe and by the sender when the push service
 * says the endpoint is gone. Idempotent: removing an endpoint that is already
 * absent is a success, because the desired state has been reached.
 */
pushSubscriptionSchema.statics.removeEndpoint = function (endpoint) {
  return this.deleteOne({ endpoint });
};

module.exports = mongoose.model("PushSubscription", pushSubscriptionSchema);
