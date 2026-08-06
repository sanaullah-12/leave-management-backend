/**
 * LogProvider.js
 * --------------
 * Writes the fully rendered message to stdout instead of sending it.
 *
 * This is the default driver, deliberately: an environment that has not been
 * configured on purpose must never be able to message real employees. It also
 * makes local development and CI possible with no vendor account, and lets a
 * reviewer read the exact copy an employee would receive.
 */

const { BaseProvider } = require("./BaseProvider");
const { mask } = require("../phone");

let sequence = 0;

class LogProvider extends BaseProvider {
  constructor() {
    super("log");
  }

  isConfigured() {
    return true;
  }

  async send({ to, body, approvedTemplate, correlationId }) {
    sequence += 1;
    const providerMessageId = `log-${Date.now()}-${sequence}`;

    const divider = "-".repeat(60);
    console.log(
      [
        `[notifications] WhatsApp (log driver) -> ${mask(to)}`,
        divider,
        body,
        divider,
        approvedTemplate
          ? `approved template: ${approvedTemplate.name} [${(approvedTemplate.params || []).join(" | ")}]`
          : "",
        `correlationId=${correlationId || "-"} messageId=${providerMessageId}`,
      ]
        .filter(Boolean)
        .join("\n")
    );

    return { providerMessageId, provider: this.name };
  }
}

module.exports = LogProvider;
