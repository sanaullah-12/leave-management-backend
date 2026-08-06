/**
 * TwilioProvider.js
 * -----------------
 * Twilio WhatsApp driver, called over Twilio's REST API directly.
 *
 * The official twilio SDK is not a dependency on purpose: this is a single
 * form-encoded POST, and axios is already in the tree. One fewer dependency to
 * keep patched for one endpoint.
 *
 * Twilio addresses WhatsApp endpoints as "whatsapp:+<E.164>". Operators
 * configure a plain number and the prefix is added here, so a paste from the
 * Twilio console works either way.
 */

const axios = require("axios");
const { BaseProvider, DeliveryError } = require("./BaseProvider");
const config = require("../config");

const asWhatsAppAddress = (number) => {
  const value = String(number || "").trim();
  if (!value) return "";
  return value.startsWith("whatsapp:") ? value : `whatsapp:${value}`;
};

class TwilioProvider extends BaseProvider {
  constructor() {
    super("twilio");
    this.settings = config.whatsapp.twilio;
  }

  isConfigured() {
    return Boolean(
      this.settings.accountSid && this.settings.authToken && this.settings.from
    );
  }

  get endpoint() {
    return `https://api.twilio.com/2010-04-01/Accounts/${this.settings.accountSid}/Messages.json`;
  }

  async send({ to, body, correlationId }) {
    if (!this.isConfigured()) {
      throw new DeliveryError("Twilio credentials are not configured", {
        retryable: false,
        provider: this.name,
      });
    }

    const form = new URLSearchParams({
      From: asWhatsAppAddress(this.settings.from),
      To: asWhatsAppAddress(to),
      Body: body,
    });

    try {
      const response = await axios.post(this.endpoint, form.toString(), {
        auth: {
          username: this.settings.accountSid,
          password: this.settings.authToken,
        },
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        timeout: config.whatsapp.timeoutMs,
      });

      return {
        providerMessageId: response.data?.sid || null,
        provider: this.name,
        raw: { sid: response.data?.sid, status: response.data?.status },
      };
    } catch (error) {
      throw this.toDeliveryError(error, correlationId);
    }
  }

  toDeliveryError(error, correlationId) {
    const status = error.response?.status || null;
    const data = error.response?.data || {};
    const detail = data.message || error.message || "Unknown error";
    const code = data.code || error.code || null;

    // 21211 invalid "To", 21614 not a valid mobile, 63007 sender mismatch:
    // configuration or data faults that no retry can fix.
    const permanentCodes = [21211, 21606, 21614, 63007, 63016];
    const retryable =
      !permanentCodes.includes(Number(code)) && BaseProvider.isRetryableStatus(status);

    return new DeliveryError(`Twilio: ${detail}`, {
      retryable,
      statusCode: status,
      provider: this.name,
      code,
      correlationId,
    });
  }
}

module.exports = TwilioProvider;
