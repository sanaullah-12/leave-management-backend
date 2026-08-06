/**
 * phone.js
 * --------
 * E.164 normalisation and validation, shared by the Mongoose model, the REST
 * validators and the WhatsApp providers so a number is judged by exactly one
 * set of rules everywhere it appears.
 *
 * E.164 is: a leading "+", a country code that cannot start with 0, and at
 * most 15 digits in total. Nothing else - no spaces, dashes or parentheses.
 */

const config = require("./config");

/** Strict E.164: "+" followed by 1-15 digits, first digit non-zero. */
const E164_PATTERN = /^\+[1-9]\d{1,14}$/;

/**
 * Strips human formatting so "+92 300 123-4567" and "+923001234567" are the
 * same number. Keeps a leading "+" and digits; drops everything else.
 */
const stripFormatting = (value) => {
  if (value === null || value === undefined) return "";
  const raw = String(value).trim();
  if (!raw) return "";

  // "00" is the ITU international prefix and means the same thing as "+".
  const withPlus = raw.startsWith("00") ? `+${raw.slice(2)}` : raw;
  const digits = withPlus.replace(/[^\d]/g, "");
  return withPlus.trim().startsWith("+") ? `+${digits}` : digits;
};

/**
 * Converts user input to canonical E.164, or returns null when it cannot be
 * done confidently.
 *
 * A number without a "+" is only accepted when a default country code is
 * configured (PHONE_DEFAULT_COUNTRY_CODE) - guessing a country from a bare
 * local number would silently message a stranger in another country.
 */
const normalize = (value, { defaultCountryCode } = {}) => {
  const cleaned = stripFormatting(value);
  if (!cleaned) return null;

  if (cleaned.startsWith("+")) {
    return E164_PATTERN.test(cleaned) ? cleaned : null;
  }

  const cc = stripFormatting(
    defaultCountryCode !== undefined
      ? defaultCountryCode
      : config.whatsapp.defaultCountryCode
  );
  if (!cc) return null;

  // A local number conventionally carries a national trunk "0" that is
  // dropped when the country code is prepended.
  const nationalNumber = cleaned.replace(/^0+/, "");
  if (!nationalNumber) return null;

  const prefix = cc.startsWith("+") ? cc : `+${cc}`;
  const candidate = `${prefix}${nationalNumber}`;
  return E164_PATTERN.test(candidate) ? candidate : null;
};

/** True when the value is already canonical E.164. */
const isValidE164 = (value) =>
  typeof value === "string" && E164_PATTERN.test(value);

/**
 * True when the value can be *stored*: either empty (the field is optional)
 * or normalisable to E.164. Used as the Mongoose validator.
 */
const isStorable = (value) => {
  if (value === null || value === undefined || value === "") return true;
  return normalize(value) !== null;
};

/**
 * Masks a number for logs: "+923001234567" -> "+9230*****67".
 * Keeps enough to correlate a support ticket without printing personal data.
 */
const mask = (value) => {
  if (!value) return "(none)";
  const str = String(value);
  if (config.logging.logFullPhoneNumbers) return str;
  if (str.length <= 6) return "*".repeat(str.length);
  const head = str.slice(0, 5);
  const tail = str.slice(-2);
  return `${head}${"*".repeat(Math.max(0, str.length - 7))}${tail}`;
};

/**
 * Providers each want their own shape. Meta wants bare digits with no "+",
 * Twilio wants a "whatsapp:+..." URI.
 */
const toDigits = (e164) => String(e164 || "").replace(/^\+/, "");

const HUMAN_READABLE_RULE =
  "Enter the number in international format, e.g. +923001234567";

module.exports = {
  E164_PATTERN,
  HUMAN_READABLE_RULE,
  stripFormatting,
  normalize,
  isValidE164,
  isStorable,
  mask,
  toDigits,
};
