/**
 * Schema validation (zod) for request bodies, params and queries.
 *
 * Schemas are strict: unknown fields are rejected rather than silently passed
 * through, which is what makes them an allowlist against mass assignment. On
 * success the parsed (trimmed, typed) value replaces the raw input, so handlers
 * only ever see validated data.
 */
const { z } = require("zod");
const mongoose = require("mongoose");

const validate = (schemas) => (req, res, next) => {
  for (const part of ["params", "query", "body"]) {
    if (!schemas[part]) continue;
    const result = schemas[part].safeParse(req[part] ?? {});
    if (!result.success) {
      const issue = result.error.issues[0];
      const field = issue && issue.path.length ? issue.path.join(".") : part;
      return res.status(400).json({
        message: issue && issue.message ? `${field}: ${issue.message}` : "Invalid request",
        code: "VALIDATION_ERROR",
      });
    }
    if (part === "query") {
      // req.query is a getter in some Express versions; mutate in place.
      Object.keys(req.query).forEach((k) => delete req.query[k]);
      Object.assign(req.query, result.data);
    } else {
      req[part] = result.data;
    }
  }
  next();
};

/* ---------------- shared field schemas ---------------- */

const objectId = z
  .string()
  .refine((v) => mongoose.isValidObjectId(v) && /^[a-f\d]{24}$/i.test(v), "must be a valid id");

const email = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .email("must be a valid email address");

/**
 * Password policy: 8-128 characters with at least one letter and one digit.
 * The upper bound keeps bcrypt (which only reads the first 72 bytes) from
 * silently ignoring the tail of a long passphrase in a surprising way, and
 * stops hashing from being used as a CPU amplifier.
 */
const password = z
  .string()
  .min(8, "must be at least 8 characters")
  .max(128, "must be at most 128 characters")
  .refine((v) => /[A-Za-z]/.test(v) && /\d/.test(v), "must contain at least one letter and one number");

/** Accepted for sign-in only, so existing (shorter) passwords still work. */
const anyPassword = z.string().min(1, "is required").max(128);

const personName = z
  .string()
  .trim()
  .min(1, "is required")
  .max(50)
  .refine((v) => !/[<>]/.test(v), "must not contain < or >");

const shortText = (max = 100) =>
  z
    .string()
    .trim()
    .max(max)
    .refine((v) => !/[<>]/.test(v), "must not contain < or >");

const phone = z.string().trim().max(32);

const isoDate = z
  .string()
  .trim()
  .refine((v) => !Number.isNaN(Date.parse(v)), "must be a valid date");

const token = z.string().regex(/^[a-f0-9]{64}$/i, "is invalid");

module.exports = {
  z,
  validate,
  schemas: { objectId, email, password, anyPassword, personName, shortText, phone, isoDate, token },
};
