/**
 * WebPushNotificationService.js
 * -----------------------------
 * The browser/OS channel: encrypt a payload and hand it to each of the
 * recipient's registered push services.
 *
 * This is a delivery channel and nothing more. It owns no history, writes no
 * Notification document and is never the record that something happened -
 * SocketNotificationService already wrote that row before this runs, and the
 * notification centre reads from there. If every push here fails, the employee
 * has still been notified in the product; they just were not tapped on the
 * shoulder outside it.
 *
 * That separation is what makes the failure handling safe to be aggressive:
 *
 *   404 / 410  the endpoint is gone (permission revoked, site data cleared,
 *              browser uninstalled). The row is deleted immediately - retrying
 *              a dead endpoint can never succeed, and keeping it means every
 *              later push pays for a guaranteed failure.
 *   anything   transient. The failure is counted, and the row is only dropped
 *   else       after enough consecutive failures that the endpoint is clearly
 *              not coming back. Deleting on the first timeout would unsubscribe
 *              people because a push service had a bad minute.
 *
 * Nothing here throws at the dispatch loop for an undeliverable device. A
 * person with three browsers registered and two of them stale must still get
 * the push on the third.
 */

const webpush = require("web-push");

const PushSubscription = require("../models/PushSubscription");
const logger = require("./NotificationLogger");
const config = require("./config");

/** Consecutive soft failures after which an endpoint is considered abandoned. */
const MAX_CONSECUTIVE_FAILURES = 5;

/** Push services reject anything larger; ours are far smaller, but be certain. */
const MAX_PAYLOAD_BYTES = 3800;

class WebPushNotificationService {
  constructor() {
    this.name = "push";
    this.configured = false;
  }

  /**
   * Hand the VAPID identity to web-push once.
   *
   * Called from init() rather than at module load so that importing the
   * notification layer never throws in an environment that has no keys - a
   * server without push configured must still start and still deliver in-app
   * notifications.
   */
  configure() {
    if (this.configured) return true;

    const { subject, publicKey, privateKey } = config.webPush;
    if (!publicKey || !privateKey) return false;

    webpush.setVapidDetails(subject, publicKey, privateKey);
    this.configured = true;
    return true;
  }

  isEnabled() {
    return config.channels.push.enabled && this.configure();
  }

  /**
   * Push one message to every browser a recipient has registered.
   *
   * @param {object} recipient          Resolved recipient ({ _id, ... }).
   * @param {object} message
   * @param {string} message.title
   * @param {string} message.body
   * @param {string=} message.url       Where a click should land in the app.
   * @param {string=} message.tag       Collapse key; a later push with the same
   *                                    tag replaces the earlier one on screen.
   * @param {object=} message.data      Extra payload for the service worker.
   * @returns {Promise<object>} { outcome, sent, removed, failed }
   */
  async send(recipient, message) {
    if (!this.isEnabled()) {
      return { outcome: "skipped:disabled", sent: 0, removed: 0, failed: 0 };
    }

    const subscriptions = await PushSubscription.forUser(recipient._id);

    if (!subscriptions.length) {
      // Not a failure. Most employees will never enable browser notifications,
      // and that is a preference rather than a fault.
      return { outcome: "skipped:no_subscription", sent: 0, removed: 0, failed: 0 };
    }

    const payload = this.encode(message);

    const results = await Promise.allSettled(
      subscriptions.map((subscription) => this.deliver(subscription, payload))
    );

    let sent = 0;
    let removed = 0;
    let failed = 0;

    for (const result of results) {
      if (result.status !== "fulfilled") {
        failed += 1;
        continue;
      }
      if (result.value === "sent") sent += 1;
      else if (result.value === "removed") removed += 1;
      else failed += 1;
    }

    logger.count("pushSent", sent);
    logger.debug("Push delivered", {
      channel: this.name,
      recipient: String(recipient._id),
      devices: subscriptions.length,
      sent,
      removed,
      failed,
    });

    return {
      outcome: sent > 0 ? "sent" : failed > 0 ? "failed" : "skipped:no_live_device",
      sent,
      removed,
      failed,
    };
  }

  /**
   * The JSON the service worker receives.
   *
   * Kept small and flat on purpose: a push payload is encrypted per device and
   * size-capped by the push service, and the service worker should not have to
   * understand the domain to render it.
   */
  encode(message) {
    const body = {
      title: message.title,
      body: message.body,
      url: message.url || "/",
      tag: message.tag || undefined,
      // Only the test push sets this. A real notification stays suppressed
      // while the app is on screen, where Socket.IO has already delivered it.
      forceShow: message.forceShow === true || undefined,
      data: message.data || {},
    };

    const json = JSON.stringify(body);
    if (Buffer.byteLength(json, "utf8") <= MAX_PAYLOAD_BYTES) return json;

    // Truncating beats failing: a shortened notification still tells the
    // employee something happened and the app has the full text.
    return JSON.stringify({
      ...body,
      body: `${String(body.body).slice(0, 300)}...`,
    });
  }

  /** One endpoint. Resolves to "sent", "removed" or "failed" - never throws. */
  async deliver(subscription, payload) {
    try {
      await webpush.sendNotification(
        {
          endpoint: subscription.endpoint,
          keys: subscription.keys,
        },
        payload,
        { TTL: config.webPush.ttlSeconds }
      );

      // Only written when it changes: a successful push on a healthy row would
      // otherwise be a write per notification per device for no information.
      if (subscription.failureCount) {
        await PushSubscription.updateOne(
          { _id: subscription._id },
          { $set: { failureCount: 0, lastPushAt: new Date() } }
        );
      } else {
        await PushSubscription.updateOne(
          { _id: subscription._id },
          { $set: { lastPushAt: new Date() } }
        );
      }

      return "sent";
    } catch (error) {
      return this.handleFailure(subscription, error);
    }
  }

  /** Decide whether a failed endpoint is dead or just having a bad moment. */
  async handleFailure(subscription, error) {
    const status = error?.statusCode;

    // 404 Not Found / 410 Gone: the push service is telling us this
    // subscription no longer exists. This is the normal end of a subscription's
    // life - the employee revoked permission, cleared site data or reinstalled.
    if (status === 404 || status === 410) {
      await PushSubscription.removeEndpoint(subscription.endpoint);
      logger.debug("Pruned an expired push subscription", {
        channel: this.name,
        user: String(subscription.user),
        status,
      });
      return "removed";
    }

    const failures = (subscription.failureCount || 0) + 1;

    if (failures >= MAX_CONSECUTIVE_FAILURES) {
      await PushSubscription.removeEndpoint(subscription.endpoint);
      logger.warn("Dropped a push subscription after repeated failures", {
        channel: this.name,
        user: String(subscription.user),
        failures,
        status: status || "none",
      });
      return "removed";
    }

    await PushSubscription.updateOne(
      { _id: subscription._id },
      { $set: { failureCount: failures } }
    );

    logger.warn("Push delivery failed", {
      channel: this.name,
      user: String(subscription.user),
      status: status || "none",
      failures,
      error: error?.message,
    });

    return "failed";
  }

  /**
   * Send a push to one specific subscription, bypassing dispatch.
   * Used by the "send me a test notification" action so an employee can confirm
   * the whole chain works the moment they enable it.
   */
  async sendToEndpoint(subscription, message) {
    if (!this.isEnabled()) return { outcome: "skipped:disabled" };
    const outcome = await this.deliver(subscription, this.encode(message));
    return { outcome };
  }
}

module.exports = new WebPushNotificationService();
module.exports.WebPushNotificationService = WebPushNotificationService;
