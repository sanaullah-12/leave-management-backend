/**
 * NotificationLogger.js
 * ---------------------
 * Structured, level-filtered logging for the notification layer.
 *
 * Delivery problems are diagnosed after the fact, from logs, by someone who
 * was not there when it happened. Every line therefore carries the event, the
 * channel and the correlation id, and phone numbers are masked by default.
 *
 * It also keeps a small in-memory counter set so the ops endpoint can answer
 * "is WhatsApp actually working right now?" without a log aggregator.
 */

const config = require("./config");
const { mask } = require("./phone");

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const PREFIX = "[notifications]";

const activeLevel = () =>
  LEVELS[config.logging.level] !== undefined ? LEVELS[config.logging.level] : LEVELS.info;

const shouldLog = (level) => LEVELS[level] <= activeLevel();

/** Renders context as `key=value` pairs - greppable, and cheap to read. */
const formatContext = (context = {}) => {
  const parts = [];
  for (const [key, value] of Object.entries(context)) {
    if (value === undefined || value === null || value === "") continue;
    const rendered =
      key === "to" || key === "phone" ? mask(value) : String(value);
    parts.push(`${key}=${rendered}`);
  }
  return parts.length ? ` ${parts.join(" ")}` : "";
};

const counters = {
  dispatched: 0,
  socketSent: 0,
  socketFailed: 0,
  whatsappSent: 0,
  whatsappFailed: 0,
  whatsappSkipped: 0,
  whatsappRetried: 0,
};

const lastErrors = [];
const MAX_LAST_ERRORS = 20;

const write = (level, message, context) => {
  if (!shouldLog(level)) return;
  const line = `${PREFIX} ${message}${formatContext(context)}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
};

const NotificationLogger = {
  error(message, context = {}) {
    write("error", message, context);
    lastErrors.unshift({
      at: new Date().toISOString(),
      message,
      channel: context.channel,
      event: context.event,
      reason: context.reason || context.error,
    });
    if (lastErrors.length > MAX_LAST_ERRORS) lastErrors.pop();
  },

  warn: (message, context = {}) => write("warn", message, context),
  info: (message, context = {}) => write("info", message, context),
  debug: (message, context = {}) => write("debug", message, context),

  /** Increments a named counter; unknown names are ignored, never thrown. */
  count(name, by = 1) {
    if (Object.prototype.hasOwnProperty.call(counters, name)) {
      counters[name] += by;
    }
  },

  /** Snapshot for the ops/health endpoint. */
  stats: () => ({ ...counters, recentErrors: [...lastErrors] }),

  reset() {
    for (const key of Object.keys(counters)) counters[key] = 0;
    lastErrors.length = 0;
  },
};

module.exports = NotificationLogger;
