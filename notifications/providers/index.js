/**
 * providers/index.js
 * ------------------
 * Provider registry. Drivers are registered by key and resolved lazily from
 * config, so adding a vendor is one require plus one map entry - no change to
 * the service, the queue, or any route.
 *
 * The instance is cached because a driver holds only configuration, and
 * rebuilding one per message would be pure waste.
 */

const LogProvider = require("./LogProvider");
const MetaCloudProvider = require("./MetaCloudProvider");
const TwilioProvider = require("./TwilioProvider");
const { BaseProvider, DeliveryError } = require("./BaseProvider");
const config = require("../config");
const logger = require("../NotificationLogger");

const REGISTRY = {
  log: LogProvider,
  meta: MetaCloudProvider,
  twilio: TwilioProvider,
};

let cached = null;
let cachedKey = null;

/**
 * Returns the driver named by WHATSAPP_PROVIDER.
 * An unknown or unconfigured name degrades to the log driver rather than
 * throwing: a configuration mistake must cost visibility, not availability.
 */
const getProvider = () => {
  const key = config.whatsapp.provider;

  if (cached && cachedKey === key) return cached;

  const Provider = REGISTRY[key];
  if (!Provider) {
    logger.error("Unknown WhatsApp provider, falling back to the log driver", {
      requested: key,
      available: Object.keys(REGISTRY).join(","),
    });
    cached = new LogProvider();
    cachedKey = key;
    return cached;
  }

  const instance = new Provider();
  if (!instance.isConfigured()) {
    logger.error("WhatsApp provider is not configured, falling back to the log driver", {
      provider: key,
    });
    cached = new LogProvider();
    cachedKey = key;
    return cached;
  }

  cached = instance;
  cachedKey = key;
  return cached;
};

/** Registers an additional driver at runtime - the seam for future vendors. */
const registerProvider = (key, ProviderClass) => {
  REGISTRY[String(key).toLowerCase()] = ProviderClass;
  cached = null;
  cachedKey = null;
};

/** Drops the cached instance so a config reload takes effect. */
const resetProvider = () => {
  cached = null;
  cachedKey = null;
};

const availableProviders = () => Object.keys(REGISTRY);

module.exports = {
  getProvider,
  registerProvider,
  resetProvider,
  availableProviders,
  BaseProvider,
  DeliveryError,
};
