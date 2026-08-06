/**
 * WhatsAppNotificationService.js
 * ------------------------------
 * The WhatsApp channel.
 *
 * Responsibilities, in order:
 *   1. Decide whether this recipient can be messaged at all (channel enabled,
 *      user opted in, a usable phone number on record).
 *   2. Normalise that number to E.164 - the number comes from the database,
 *      never from a caller, never from a constant.
 *   3. Enqueue the send. The provider call happens on a queue worker, so a
 *      slow or dead vendor cannot extend an HTTP request by one millisecond.
 *
 * Everything here is best-effort by construction. `send()` resolves to a
 * result object describing what happened and never rejects, because the caller
 * is a business transaction that must succeed whatever WhatsApp does.
 */

const config = require("./config");
const logger = require("./NotificationLogger");
const queue = require("./NotificationQueue");
const { getProvider } = require("./providers");
const { normalize, mask } = require("./phone");
const { acceptsChannel } = require("./RecipientResolver");

const JOB_TYPE = "whatsapp.send";

/** Outcomes, so callers and the ops endpoint speak the same vocabulary. */
const OUTCOME = Object.freeze({
  QUEUED: "queued",
  SKIPPED_DISABLED: "skipped:channel_disabled",
  SKIPPED_OPTED_OUT: "skipped:opted_out",
  SKIPPED_NO_PHONE: "skipped:no_phone",
  SKIPPED_INVALID_PHONE: "skipped:invalid_phone",
  SKIPPED_NO_TEMPLATE: "skipped:no_template",
});

class WhatsAppNotificationService {
  constructor() {
    this.name = "whatsapp";
    this.registerWorker();
  }

  isEnabled() {
    return config.channels.whatsapp.enabled;
  }

  /**
   * Registers the queue worker that performs the actual provider call.
   * The provider is resolved per job rather than captured once, so a runtime
   * provider swap (or a fallback to the log driver) takes effect immediately.
   */
  registerWorker() {
    queue.register(JOB_TYPE, async (payload, job) => {
      const provider = getProvider();

      try {
        const result = await provider.send({
          to: payload.to,
          body: payload.body,
          approvedTemplate: payload.approvedTemplate,
          correlationId: payload.correlationId,
        });

        logger.count("whatsappSent");
        logger.info("WhatsApp message sent", {
          channel: this.name,
          event: payload.event,
          provider: provider.name,
          to: payload.to,
          messageId: result.providerMessageId,
          correlationId: payload.correlationId,
        });

        return result;
      } catch (error) {
        // Count the outcome here, where the queue's retry decision is visible.
        // Without this the delivery counters would show zero failures while
        // messages were dying in the queue - the health endpoint would lie.
        const isFinal =
          error.retryable === false || job.attempts >= job.maxAttempts;
        logger.count(isFinal ? "whatsappFailed" : "whatsappRetried");
        throw error;
      }
    });
  }

  /**
   * Queues one WhatsApp message for one recipient.
   *
   * @param {object} recipient  Resolved recipient carrying `phone`.
   * @param {object} message    { event, body, approvedTemplate, correlationId }
   * @returns {Promise<{outcome: string, jobId?: string, reason?: string}>}
   */
  async send(recipient, message) {
    const { event, body, approvedTemplate, correlationId } = message;

    if (!this.isEnabled()) {
      return { outcome: OUTCOME.SKIPPED_DISABLED };
    }

    if (!body) {
      // No WhatsApp copy for this event: an in-app-only notification.
      return { outcome: OUTCOME.SKIPPED_NO_TEMPLATE };
    }

    if (!acceptsChannel(recipient, "whatsapp")) {
      logger.count("whatsappSkipped");
      logger.debug("Recipient has opted out of WhatsApp", {
        channel: this.name,
        event,
        recipient: String(recipient._id),
      });
      return { outcome: OUTCOME.SKIPPED_OPTED_OUT };
    }

    if (!recipient.phone) {
      logger.count("whatsappSkipped");
      logger.warn("Recipient has no phone number on record", {
        channel: this.name,
        event,
        recipient: String(recipient._id),
        name: recipient.name,
      });
      return { outcome: OUTCOME.SKIPPED_NO_PHONE };
    }

    const to = normalize(recipient.phone);
    if (!to) {
      logger.count("whatsappSkipped");
      logger.warn("Recipient phone number is not valid E.164", {
        channel: this.name,
        event,
        recipient: String(recipient._id),
        phone: recipient.phone,
      });
      return { outcome: OUTCOME.SKIPPED_INVALID_PHONE };
    }

    // Non-production safety valve: keep test traffic away from real people.
    const destination = config.whatsapp.redirectAllTo
      ? normalize(config.whatsapp.redirectAllTo) || to
      : to;

    if (destination !== to) {
      logger.warn("WhatsApp traffic is being redirected", {
        channel: this.name,
        intended: to,
        to: destination,
      });
    }

    const jobId = queue.enqueue(
      JOB_TYPE,
      {
        to: destination,
        body,
        approvedTemplate,
        event,
        recipientId: String(recipient._id),
        correlationId,
      },
      { correlationId }
    );

    if (!jobId) {
      logger.count("whatsappFailed");
      return { outcome: "failed", reason: "queue rejected the job" };
    }

    logger.debug("WhatsApp message queued", {
      channel: this.name,
      event,
      jobId,
      to: destination,
      correlationId,
    });

    return { outcome: OUTCOME.QUEUED, jobId };
  }

  /**
   * Sends a single ad-hoc message, bypassing templates and the recipient
   * resolver. Used only by the operator "test send" endpoint, so an admin can
   * prove the provider works before trusting it with real notifications.
   */
  async sendDirect({ to, body, correlationId = "manual-test" }) {
    const normalized = normalize(to);
    if (!normalized) {
      const error = new Error(`"${to}" is not a valid E.164 phone number`);
      error.retryable = false;
      throw error;
    }

    const provider = getProvider();
    return provider.send({ to: normalized, body, correlationId });
  }

  /** Snapshot for the ops endpoint: is this channel actually usable? */
  health() {
    const provider = getProvider();
    return {
      enabled: this.isEnabled(),
      configuredProvider: config.whatsapp.provider,
      activeProvider: provider.name,
      providerConfigured: provider.isConfigured(),
      usingApprovedTemplates: config.whatsapp.meta.useApprovedTemplates,
      redirectAllTo: config.whatsapp.redirectAllTo
        ? mask(config.whatsapp.redirectAllTo)
        : null,
      problems: config.validate(),
    };
  }
}

module.exports = new WhatsAppNotificationService();
module.exports.WhatsAppNotificationService = WhatsAppNotificationService;
module.exports.OUTCOME = OUTCOME;
module.exports.JOB_TYPE = JOB_TYPE;
