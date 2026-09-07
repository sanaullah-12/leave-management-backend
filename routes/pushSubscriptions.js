/**
 * routes/pushSubscriptions.js
 * ---------------------------
 * Managing a browser's permission to be pushed to. Nothing else.
 *
 * This router owns push transport and no business logic: it never decides what
 * is worth notifying anyone about, never reads a leave or an attendance record,
 * and nothing in the product needs it to have run. An employee who never opens
 * this endpoint still gets every in-app notification - they simply are not
 * tapped on the shoulder outside the tab.
 *
 * Every route is authenticated and every route acts on `req.user`. A
 * subscription is stored against the authenticated user and can only be read or
 * removed by them: the endpoint in the body says which browser, the JWT says
 * which person, and the two are never taken from the same place.
 */

const express = require("express");
const crypto = require("crypto");
const router = express.Router();

const { authenticateToken } = require("../middleware/auth");
const PushSubscription = require("../models/PushSubscription");
const WebPushNotificationService = require("../notifications/WebPushNotificationService");
const config = require("../notifications/config");

/**
 * A stable, meaningless label for one device row.
 *
 * A hash rather than a slice of the endpoint: an endpoint is a capability URL,
 * and two of them can share a tail, which would show an employee two identical
 * rows for two different browsers.
 */
const fingerprint = (endpoint) =>
  crypto.createHash("sha256").update(endpoint).digest("hex").slice(0, 10);

/** A browser endpoint is a URL from the push service. Anything else is a bug. */
const isValidEndpoint = (value) =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 2000 &&
  /^https:\/\//.test(value);

/**
 * GET /api/push/vapid-public-key
 *
 * The browser needs the server's public key before it can subscribe. It is
 * public by definition - it is embedded in every subscription request the
 * browser makes - but it is served behind auth anyway so an unauthenticated
 * scraper cannot enumerate deployments.
 */
router.get("/vapid-public-key", authenticateToken, (req, res) => {
  const publicKey = config.webPush.publicKey;

  if (!publicKey || !config.channels.push.enabled) {
    // 200 with supported:false, not an error: "push is not configured on this
    // deployment" is a normal answer that the UI renders as an unavailable
    // toggle rather than a failure.
    return res.json({
      success: true,
      supported: false,
      publicKey: null,
      message: "Push notifications are not configured on this server.",
    });
  }

  res.json({ success: true, supported: true, publicKey });
});

/**
 * GET /api/push/status
 * Whether this user has any registered device, for rendering the toggle.
 */
router.get("/status", authenticateToken, async (req, res) => {
  try {
    const devices = await PushSubscription.find({ user: req.user._id })
      .select("endpoint userAgent lastSeenAt lastPushAt createdAt")
      .sort({ lastSeenAt: -1 })
      .lean();

    res.json({
      success: true,
      supported: Boolean(config.webPush.publicKey && config.channels.push.enabled),
      subscribed: devices.length > 0,
      deviceCount: devices.length,
      // The endpoint itself is never returned - it is a capability URL, and
      // anyone holding one could be pushed to. A hash is enough to tell rows
      // apart in a device list.
      devices: devices.map((device) => ({
        id: String(device._id),
        fingerprint: fingerprint(device.endpoint),
        userAgent: device.userAgent,
        lastSeenAt: device.lastSeenAt,
        lastPushAt: device.lastPushAt,
        createdAt: device.createdAt,
      })),
    });
  } catch (error) {
    console.error("Failed to read push subscription status:", error.message);
    res.status(500).json({
      success: false,
      code: "PUSH_STATUS_ERROR",
      message: "Could not read your notification devices.",
    });
  }
});

/**
 * POST /api/push/subscribe
 *
 * Called after the browser has granted permission and produced a subscription.
 * Idempotent by endpoint, so re-registering on every login updates one row
 * instead of accumulating dead ones - which is also what re-homes a browser
 * when a different employee logs into it.
 */
router.post("/subscribe", authenticateToken, async (req, res) => {
  try {
    const { endpoint, keys } = req.body || {};

    if (!isValidEndpoint(endpoint)) {
      return res.status(400).json({
        success: false,
        code: "BAD_ENDPOINT",
        message: "A valid https push endpoint is required.",
      });
    }

    if (!keys || typeof keys.p256dh !== "string" || typeof keys.auth !== "string") {
      return res.status(400).json({
        success: false,
        code: "BAD_KEYS",
        message: "The subscription is missing its encryption keys.",
      });
    }

    if (!req.user.company) {
      return res.status(409).json({
        success: false,
        code: "NO_COMPANY",
        message: "Your account is not attached to a company.",
      });
    }

    const subscription = await PushSubscription.register({
      user: req.user._id,
      company: req.user.company._id || req.user.company,
      endpoint,
      keys: { p256dh: keys.p256dh, auth: keys.auth },
      // Truncated: it is a label for a device list, not data to act on.
      userAgent: String(req.get("user-agent") || "").slice(0, 300),
    });

    res.json({
      success: true,
      subscribed: true,
      deviceId: String(subscription._id),
    });
  } catch (error) {
    console.error("Failed to store a push subscription:", error.message);
    res.status(500).json({
      success: false,
      code: "SUBSCRIBE_ERROR",
      message: "Could not register this device for notifications.",
    });
  }
});

/**
 * POST /api/push/unsubscribe
 *
 * Removes one browser. Scoped to the caller so a leaked endpoint cannot be used
 * to silence somebody else's device.
 *
 * Deleting something that is already gone is a success: the caller asked for
 * "this browser is not subscribed", and that is now true either way. Logging
 * out on a browser whose subscription already expired must not report an error.
 */
router.post("/unsubscribe", authenticateToken, async (req, res) => {
  try {
    const { endpoint } = req.body || {};

    if (!isValidEndpoint(endpoint)) {
      return res.status(400).json({
        success: false,
        code: "BAD_ENDPOINT",
        message: "A valid https push endpoint is required.",
      });
    }

    const result = await PushSubscription.deleteOne({
      endpoint,
      user: req.user._id,
    });

    res.json({ success: true, subscribed: false, removed: result.deletedCount });
  } catch (error) {
    console.error("Failed to remove a push subscription:", error.message);
    res.status(500).json({
      success: false,
      code: "UNSUBSCRIBE_ERROR",
      message: "Could not remove this device.",
    });
  }
});

/**
 * POST /api/push/test
 *
 * Sends one push to the caller's own devices, so an employee can confirm the
 * whole chain works the moment they enable it rather than waiting for a real
 * event. It goes through the same channel service as every real push, so a
 * success here means real notifications will arrive too.
 */
router.post("/test", authenticateToken, async (req, res) => {
  try {
    const result = await WebPushNotificationService.send(
      { _id: req.user._id },
      {
        title: "Notifications are on",
        body: "You will now receive attendance, leave, WFH and HR updates here.",
        url: "/notifications",
        tag: "push-test",
        // Shown even with the app in front of them - the point of this one is
        // to prove an OS notification arrives, and they are certainly looking
        // at the tab they just clicked in.
        forceShow: true,
      }
    );

    res.json({ success: true, ...result });
  } catch (error) {
    console.error("Push test failed:", error.message);
    res.status(500).json({
      success: false,
      code: "PUSH_TEST_ERROR",
      message: "Could not send a test notification.",
    });
  }
});

module.exports = router;
