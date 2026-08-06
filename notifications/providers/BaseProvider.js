/**
 * BaseProvider.js
 * ---------------
 * The contract every WhatsApp driver implements. WhatsAppNotificationService
 * only ever talks to this shape, which is what keeps business logic free of
 * any single vendor: swapping Meta for Twilio is one env variable.
 *
 * A driver must:
 *   - report whether it is configured, without throwing;
 *   - send a message and return a provider message id;
 *   - classify its failures as retryable or not, so the queue does not burn
 *     attempts on an error that will never resolve itself (a bad token, an
 *     unregistered recipient).
 */

/**
 * A delivery failure carrying the one piece of information the queue needs:
 * whether trying again could plausibly succeed.
 */
class DeliveryError extends Error {
  constructor(message, { retryable = false, statusCode = null, provider = null, code = null } = {}) {
    super(message);
    this.name = "DeliveryError";
    this.retryable = retryable;
    this.statusCode = statusCode;
    this.provider = provider;
    this.code = code;
  }
}

class BaseProvider {
  constructor(name) {
    this.name = name;
  }

  /** True when this driver has everything it needs to attempt a send. */
  isConfigured() {
    return false;
  }

  /**
   * Delivers one message.
   *
   * @param {object}  message
   * @param {string}  message.to       Recipient in canonical E.164.
   * @param {string}  message.body     Rendered free-form text.
   * @param {object=} message.approvedTemplate  { name, params } for providers
   *        that require a pre-approved template outside the 24-hour window.
   * @param {string=} message.correlationId     Carried into provider logs.
   * @returns {Promise<{providerMessageId: string, provider: string, raw?: object}>}
   * @throws {DeliveryError}
   */
  // eslint-disable-next-line no-unused-vars
  async send(message) {
    throw new DeliveryError(`Provider "${this.name}" does not implement send()`, {
      retryable: false,
      provider: this.name,
    });
  }

  /**
   * HTTP status to retryability. Shared by the HTTP-based drivers.
   * 408/429 and 5xx are transient; the rest are the caller's fault and will
   * fail identically on every retry.
   */
  static isRetryableStatus(status) {
    if (!status) return true; // No response at all: network or timeout.
    return status === 408 || status === 429 || status >= 500;
  }
}

module.exports = { BaseProvider, DeliveryError };
