/**
 * NotificationService.js
 * ----------------------
 * The single entry point business code uses to notify anyone about anything.
 *
 *   Application event -> NotificationService.dispatch()
 *                          |
 *              +-----------+-----------+
 *              |                       |
 *      SocketNotificationService   WhatsAppNotificationService
 *              |                       |
 *      in-app notification       WhatsApp message
 *
 * Two rules define the design:
 *
 *   1. Channels are independent. Each recipient's channels are settled
 *      separately, so a WhatsApp outage cannot stop an in-app notification and
 *      an in-app failure cannot stop a WhatsApp message.
 *
 *   2. Recipients are resolved, never supplied. A caller states the audience;
 *      RecipientResolver answers who that is right now, from the database.
 *
 * Adding a channel (SMS, push, Slack, Teams) is `registerChannel()` plus a
 * renderer in NotificationTemplates - no route, controller or model changes.
 */

const crypto = require("crypto");

const templates = require("./NotificationTemplates");
const logger = require("./NotificationLogger");
const recipientResolver = require("./RecipientResolver");
const socketService = require("./SocketNotificationService");
const whatsappService = require("./WhatsAppNotificationService");
const { metadataFor, isKnownEvent } = require("./NotificationEvents");
const config = require("./config");

const newCorrelationId = () =>
  typeof crypto.randomUUID === "function"
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10);

/**
 * A channel adapter bridges a channel service to the dispatch loop: it knows
 * how to turn (event, payload) into that channel's message shape, and returns
 * null when the event has nothing to say on that channel.
 */
const CHANNEL_ADAPTERS = new Map();

CHANNEL_ADAPTERS.set("socket", {
  service: socketService,
  isEnabled: () => config.channels.socket.enabled,
  build: (event, payload, context) => {
    const meta = metadataFor(event);
    // The in-app notification type is a required, enum-constrained column.
    // An event without one is simply not an in-app notification.
    const type = context.inAppType || meta?.inAppType;
    if (!type) return null;

    // An explicit override wins over the template. This is what lets the
    // existing notification copy stay byte-for-byte identical while new code
    // gets its copy from the template registry.
    const rendered = context.inApp || templates.render(event, "inApp", payload);
    if (!rendered || !rendered.title || !rendered.message) return null;

    return {
      type,
      title: rendered.title,
      body: rendered.message,
      company: context.companyId,
      sender: context.senderId,
      refs: context.refs || {},
    };
  },
});

CHANNEL_ADAPTERS.set("whatsapp", {
  service: whatsappService,
  isEnabled: () => config.channels.whatsapp.enabled,
  build: (event, payload, context) => {
    const rendered = templates.render(event, "whatsapp", payload);
    if (!rendered || !rendered.body) return null;

    return {
      event,
      body: rendered.body,
      approvedTemplate: rendered.approvedTemplate,
      correlationId: context.correlationId,
    };
  },
});

class NotificationService {
  /**
   * Notifies an audience about an event across every enabled channel.
   *
   * @param {object}   options
   * @param {string}   options.event        A NOTIFICATION_EVENTS value.
   * @param {object}   options.payload      Data the templates render from.
   * @param {string}   options.companyId    Tenant scope. Required.
   * @param {string=}  options.userId       Target for single-user audiences.
   * @param {string=}  options.senderId     Who caused the event, if a person did.
   * @param {object=}  options.refs         { leaveId, voiceId, announcementId }
   * @param {Array=}   options.recipients   Pre-resolved recipients; skips resolution.
   * @param {string=}  options.audience     Overrides the event's default audience.
   * @param {string=}  options.excludeUserId Never notify this user (usually the actor).
   * @param {string[]=} options.channels    Restrict to a subset of channels.
   * @param {object=}  options.inApp        { title, message } copy override.
   * @param {string=}  options.inAppType    Notification.type override.
   *
   * @returns {Promise<object>} A per-channel summary. Resolves even when
   *          everything failed; inspect `result.socket.failed` to react.
   */
  async dispatch(options) {
    const {
      event,
      payload = {},
      companyId,
      userId,
      senderId,
      refs = {},
      recipients: providedRecipients,
      audience: audienceOverride,
      excludeUserId,
      channels: channelFilter,
      inApp,
      inAppType,
    } = options;

    const correlationId = options.correlationId || newCorrelationId();

    const summary = {
      event,
      correlationId,
      recipientCount: 0,
      socket: { sent: [], failed: [] },
      whatsapp: { queued: 0, skipped: [], failed: [] },
    };

    if (!isKnownEvent(event)) {
      logger.error("Dispatch for an unknown event was ignored", { event, correlationId });
      return summary;
    }

    const meta = metadataFor(event);
    const audience = audienceOverride || meta.audience;

    let recipients;
    try {
      recipients =
        providedRecipients ||
        (await recipientResolver.resolve(audience, {
          companyId,
          userId,
          excludeUserId,
        }));
    } catch (error) {
      // Failing to resolve recipients is a real fault, but it is still not the
      // caller's problem: the leave request has already been saved.
      logger.error("Recipient resolution failed", {
        event,
        correlationId,
        audience,
        error: error.message,
      });
      return summary;
    }

    summary.recipientCount = recipients.length;
    logger.count("dispatched");

    if (recipients.length === 0) {
      logger.warn("Dispatch resolved to no recipients", { event, correlationId, audience });
      return summary;
    }

    const adapters = [...CHANNEL_ADAPTERS.entries()].filter(([name, adapter]) => {
      if (channelFilter && !channelFilter.includes(name)) return false;
      return adapter.isEnabled();
    });

    const context = {
      companyId,
      senderId,
      refs,
      correlationId,
      inApp,
      inAppType,
    };

    // Every (recipient, channel) pair is settled independently. One failure
    // never cancels another delivery - that is the whole fault-tolerance
    // guarantee, expressed in one line.
    await Promise.allSettled(
      recipients.flatMap((recipient) =>
        adapters.map(async ([name, adapter]) => {
          try {
            const message = adapter.build(event, payload, context);
            if (!message) return;

            const result = await adapter.service.send(recipient, message);
            this.record(summary, name, recipient, result);
          } catch (error) {
            this.recordFailure(summary, name, recipient, error, correlationId, event);
          }
        })
      )
    );

    logger.info("Dispatch complete", {
      event,
      correlationId,
      recipients: summary.recipientCount,
      inApp: summary.socket.sent.length,
      inAppFailed: summary.socket.failed.length,
      whatsappQueued: summary.whatsapp.queued,
      whatsappSkipped: summary.whatsapp.skipped.length,
    });

    return summary;
  }

  record(summary, channel, recipient, result) {
    if (channel === "socket") {
      summary.socket.sent.push(result);
      return;
    }
    if (channel === "whatsapp") {
      if (result?.outcome === "queued") summary.whatsapp.queued += 1;
      else if (result?.outcome?.startsWith("skipped")) {
        summary.whatsapp.skipped.push({
          recipient: String(recipient._id),
          reason: result.outcome,
        });
      } else {
        summary.whatsapp.failed.push({
          recipient: String(recipient._id),
          reason: result?.reason || result?.outcome || "unknown",
        });
      }
    }
  }

  recordFailure(summary, channel, recipient, error, correlationId, event) {
    logger.error(`Channel "${channel}" failed for a recipient`, {
      channel,
      event,
      correlationId,
      recipient: String(recipient._id),
      error: error.message,
    });

    if (channel === "socket") {
      logger.count("socketFailed");
      summary.socket.failed.push({ recipient: String(recipient._id), error });
    } else {
      logger.count("whatsappFailed");
      summary.whatsapp.failed.push({
        recipient: String(recipient._id),
        reason: error.message,
      });
    }
  }

  /**
   * Registers an additional channel. This is the extension point for SMS,
   * push, Slack or Teams: provide a service with `send(recipient, message)`
   * and a `build()` that renders the event, then add a renderer of the same
   * name to NotificationTemplates.
   */
  registerChannel(name, adapter) {
    if (!adapter || typeof adapter.build !== "function" || !adapter.service) {
      throw new TypeError(`Channel "${name}" needs { service, build, isEnabled }`);
    }
    CHANNEL_ADAPTERS.set(name, {
      isEnabled: () => true,
      ...adapter,
    });
    logger.info("Channel registered", { channel: name });
  }

  registeredChannels() {
    return [...CHANNEL_ADAPTERS.keys()];
  }

  /**
   * Logs the notification layer's effective configuration once at boot, and
   * surfaces anything that would silently prevent delivery.
   */
  init() {
    const problems = config.validate();

    logger.info("Notification layer ready", {
      channels: this.registeredChannels().join(","),
      whatsapp: config.channels.whatsapp.enabled ? "enabled" : "disabled",
      provider: config.whatsapp.provider,
      adminRoles: config.recipients.adminRoles.join(","),
    });

    for (const problem of problems) {
      logger.error("Notification configuration problem", { reason: problem });
    }

    return problems;
  }
}

module.exports = new NotificationService();
module.exports.NotificationService = NotificationService;
