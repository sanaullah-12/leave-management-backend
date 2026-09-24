/**
 * Request- and response-level hardening applied to every API route.
 *
 *  - rejectOperatorKeys: MongoDB operator injection. A body such as
 *    {"email": {"$ne": null}} would otherwise reach a query filter as an
 *    operator. Keys starting with "$" and prototype-pollution keys are refused
 *    anywhere in the body, query or path parameters.
 *  - collapseQueryArrays: HTTP parameter pollution. "?status=a&status=b"
 *    becomes the last value, so handlers always see strings.
 *  - safeErrorResponses: in production, 5xx bodies never carry exception
 *    messages, stack traces or internal details, whatever the handler put there.
 *  - permissionsPolicy: browser features the API never needs are switched off.
 */

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const MAX_DEPTH = 20;

const findForbiddenKey = (value, depth = 0) => {
  if (value === null || typeof value !== "object") return null;
  if (depth > MAX_DEPTH) return "(nesting too deep)";
  for (const key of Object.keys(value)) {
    if (key.startsWith("$") || FORBIDDEN_KEYS.has(key)) return key;
    const nested = findForbiddenKey(value[key], depth + 1);
    if (nested) return nested;
  }
  return null;
};

const rejectOperatorKeys = (req, res, next) => {
  const offending =
    findForbiddenKey(req.body) ||
    findForbiddenKey(req.query) ||
    findForbiddenKey(req.params);
  if (offending) {
    return res.status(400).json({ message: "Request contains a disallowed field name" });
  }
  next();
};

const collapseQueryArrays = (req, res, next) => {
  for (const key of Object.keys(req.query)) {
    const value = req.query[key];
    if (Array.isArray(value)) req.query[key] = value[value.length - 1];
  }
  next();
};

const isProduction = () => process.env.NODE_ENV === "production";

const safeErrorResponses = (req, res, next) => {
  const originalJson = res.json.bind(res);
  res.json = (body) => {
    if (body && typeof body === "object" && !Array.isArray(body)) {
      if (res.statusCode >= 500 && isProduction()) {
        const message =
          typeof body.message === "string" && body.message.length <= 200
            ? body.message
            : "Something went wrong";
        return originalJson({ success: false, message });
      }
      if ("stack" in body) {
        const { stack, ...rest } = body;
        return originalJson(rest);
      }
    }
    return originalJson(body);
  };
  next();
};

const PERMISSIONS_POLICY = [
  "accelerometer=()",
  "camera=()",
  "geolocation=()",
  "gyroscope=()",
  "magnetometer=()",
  "microphone=()",
  "payment=()",
  "usb=()",
  "interest-cohort=()",
].join(", ");

const permissionsPolicy = (req, res, next) => {
  res.setHeader("Permissions-Policy", PERMISSIONS_POLICY);
  next();
};

/** Authenticated API responses must never be stored by shared caches. */
const noStoreApi = (req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
  next();
};

module.exports = {
  rejectOperatorKeys,
  collapseQueryArrays,
  safeErrorResponses,
  permissionsPolicy,
  noStoreApi,
};
