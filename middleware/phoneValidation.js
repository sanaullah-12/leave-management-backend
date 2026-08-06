/**
 * phoneValidation.js
 * ------------------
 * Rejects a malformed phone number at the edge, with a message a user can act
 * on, and canonicalises a valid one before it reaches a model.
 *
 * The Mongoose validator is the last line of defence and would also catch this,
 * but a schema validation error surfaces as a 500-shaped "Failed to update
 * profile" in these routes. Validating here turns the same mistake into a 400
 * that names the field and shows the expected format.
 */

const phoneUtil = require("../notifications/phone");

/**
 * Validates and normalises `req.body[field]` in place.
 * An absent or empty value passes: the number is optional everywhere, and only
 * WhatsApp delivery depends on it.
 *
 * @param {string} field  Body property to check. Defaults to "phone".
 */
const validatePhoneField = (field = "phone") => (req, res, next) => {
  const value = req.body?.[field];

  if (value === undefined || value === null || String(value).trim() === "") {
    return next();
  }

  const normalized = phoneUtil.normalize(value);
  if (!normalized) {
    return res.status(400).json({
      message: `Invalid phone number. ${phoneUtil.HUMAN_READABLE_RULE}`,
      field,
      received: String(value),
    });
  }

  req.body[field] = normalized;
  return next();
};

module.exports = { validatePhoneField };
