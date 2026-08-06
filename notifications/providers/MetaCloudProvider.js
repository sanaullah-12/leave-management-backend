/**
 * MetaCloudProvider.js
 * --------------------
 * Meta WhatsApp Cloud API driver (graph.facebook.com).
 *
 * Two send modes, because Meta enforces a policy the code has to respect:
 *
 *   free-form text  - only delivered inside the 24-hour "customer service
 *                     window" that opens when the user last messaged the
 *                     business. Outside it, Meta accepts the request and then
 *                     silently fails to deliver.
 *   approved template - always delivered, but the template must be registered
 *                     and approved in the Meta Business Manager first.
 *
 * HRMS notifications are business-initiated, so production deployments should
 * set WHATSAPP_USE_APPROVED_TEMPLATES=true and register the template names
 * listed in NotificationTemplates.js. The free-form path stays for sandbox
 * testing and for replies inside an open window.
 */

const axios = require("axios");
const { BaseProvider, DeliveryError } = require("./BaseProvider");
const config = require("../config");
const { toDigits } = require("../phone");

class MetaCloudProvider extends BaseProvider {
  constructor() {
    super("meta");
    this.settings = config.whatsapp.meta;
  }

  isConfigured() {
    return Boolean(this.settings.phoneNumberId && this.settings.accessToken);
  }

  get endpoint() {
    return `https://graph.facebook.com/${this.settings.apiVersion}/${this.settings.phoneNumberId}/messages`;
  }

  /** Builds the request body for whichever mode is configured. */
  buildPayload({ to, body, approvedTemplate }) {
    const recipient = toDigits(to); // Meta wants digits only, no leading "+".

    if (this.settings.useApprovedTemplates && approvedTemplate) {
      const parameters = (approvedTemplate.params || []).map((value) => ({
        type: "text",
        // Meta rejects empty parameters outright, so a missing optional field
        // becomes "-" rather than failing the whole send.
        text: String(value === undefined || value === null || value === "" ? "-" : value),
      }));

      return {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: recipient,
        type: "template",
        template: {
          name: approvedTemplate.name,
          language: { code: this.settings.templateLanguage },
          ...(parameters.length
            ? { components: [{ type: "body", parameters }] }
            : {}),
        },
      };
    }

    return {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: recipient,
      type: "text",
      text: { preview_url: false, body },
    };
  }

  async send({ to, body, approvedTemplate, correlationId }) {
    if (!this.isConfigured()) {
      throw new DeliveryError("Meta Cloud API credentials are not configured", {
        retryable: false,
        provider: this.name,
      });
    }

    try {
      const response = await axios.post(this.endpoint, this.buildPayload({ to, body, approvedTemplate }), {
        headers: {
          Authorization: `Bearer ${this.settings.accessToken}`,
          "Content-Type": "application/json",
        },
        timeout: config.whatsapp.timeoutMs,
      });

      const messageId = response.data?.messages?.[0]?.id || null;
      return {
        providerMessageId: messageId,
        provider: this.name,
        raw: response.data,
      };
    } catch (error) {
      throw this.toDeliveryError(error, correlationId);
    }
  }

  /**
   * Translates an axios failure into a DeliveryError with a usable message.
   * Meta nests the real cause under data.error, and the top-level HTTP status
   * alone is not enough to decide whether a retry is worth an attempt.
   */
  toDeliveryError(error, correlationId) {
    const status = error.response?.status || null;
    const metaError = error.response?.data?.error || {};
    const detail =
      metaError.error_user_msg || metaError.message || error.message || "Unknown error";
    const code = metaError.code || error.code || null;

    // 131047 / 131026: outside the 24-hour window, or the number cannot
    // receive messages. Retrying changes nothing; the fix is an approved
    // template or a valid recipient.
    const permanentCodes = [131026, 131047, 131051, 100, 190];
    const retryable =
      !permanentCodes.includes(Number(code)) && BaseProvider.isRetryableStatus(status);

    return new DeliveryError(`Meta Cloud API: ${detail}`, {
      retryable,
      statusCode: status,
      provider: this.name,
      code,
      correlationId,
    });
  }
}

module.exports = MetaCloudProvider;
