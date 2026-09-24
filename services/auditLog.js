/**
 * Writes the security audit trail.
 *
 * Recording is best-effort by design: a failure to audit is logged loudly but
 * never turns a successful business operation into an error for the user.
 *
 * Writes are serialised in-process so each company's hash chain stays linear.
 * With more than one backend instance, move the chain head into a single
 * atomic document (findOneAndUpdate on a per-company counter) instead.
 */
const crypto = require("crypto");
const AuditLog = require("../models/AuditLog");

const GENESIS = "0".repeat(64);
const SENSITIVE_KEY = /pass|token|secret|authorization|cookie|otp|cnic|bank|salary/i;
const MAX_STRING = 300;

/** Drop credential-like keys and bound the size of whatever remains. */
const sanitizeMetadata = (value, depth = 0) => {
  if (value === null || value === undefined) return value;
  if (depth > 3) return "[truncated]";
  if (typeof value === "string") return value.slice(0, MAX_STRING);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((v) => sanitizeMetadata(v, depth + 1));
  }
  if (typeof value === "object") {
    if (typeof value.toHexString === "function") return value.toHexString();
    const out = {};
    for (const [key, v] of Object.entries(value).slice(0, 30)) {
      if (SENSITIVE_KEY.test(key) || key.startsWith("$")) continue;
      const clean = sanitizeMetadata(v, depth + 1);
      // Omitted rather than stored: BSON would persist undefined as null and
      // the recomputed chain hash would no longer match.
      if (clean !== undefined) out[key] = clean;
    }
    return out;
  }
  return undefined;
};

const idOf = (v) => (v && (v._id || v) ? String(v._id || v) : null);

/** Canonical form of an entry: the exact bytes the chain hash covers. */
const canonical = (entry) =>
  JSON.stringify([
    entry.company ? String(entry.company) : null,
    entry.actor ? String(entry.actor) : null,
    entry.actorRole || null,
    entry.action,
    entry.outcome,
    entry.targetType || null,
    entry.targetId || null,
    entry.metadata === undefined ? null : entry.metadata,
    entry.ip || null,
    entry.userAgent || null,
    new Date(entry.createdAt).toISOString(),
    entry.prevHash,
  ]);

const hashEntry = (entry) =>
  crypto.createHash("sha256").update(canonical(entry)).digest("hex");

let queue = Promise.resolve();

/**
 * Record one security-relevant event.
 *
 * @param {object} event
 * @param {string} event.action      Dotted name, e.g. "auth.login.failure".
 * @param {object} [event.req]       Express request: actor, IP and user agent are taken from it.
 * @param {object} [event.actor]     Overrides req.user (e.g. a user resolved during login).
 * @param {*}      [event.company]   Defaults to the actor's company.
 * @param {string} [event.outcome]   "success" | "failure" | "denied".
 * @param {string} [event.targetType]
 * @param {*}      [event.targetId]
 * @param {object} [event.metadata]  Non-sensitive context. Credential-like keys are removed.
 */
const record = (event) => {
  const { req, action } = event;
  const actor = event.actor || (req && req.user) || null;
  const company =
    event.company !== undefined ? event.company : actor && actor.company;

  const entry = {
    company: idOf(company),
    actor: idOf(actor),
    actorRole: actor && actor.role ? String(actor.role) : undefined,
    action: String(action).slice(0, 64),
    outcome: event.outcome || "success",
    targetType: event.targetType,
    targetId: event.targetId !== undefined && event.targetId !== null
      ? String(event.targetId._id || event.targetId).slice(0, 64)
      : undefined,
    metadata: sanitizeMetadata(event.metadata),
    ip: req ? String(req.ip || "").slice(0, 64) : undefined,
    userAgent: req
      ? String(req.headers["user-agent"] || "").slice(0, 200)
      : undefined,
  };

  queue = queue
    .then(async () => {
      const last = await AuditLog.findOne({ company: entry.company })
        .sort({ createdAt: -1, _id: -1 })
        .select("hash createdAt")
        .lean();
      entry.prevHash = last ? last.hash : GENESIS;
      // Strictly increasing per chain, so ordering by createdAt is unambiguous.
      const now = Date.now();
      entry.createdAt = new Date(
        last && now <= new Date(last.createdAt).getTime()
          ? new Date(last.createdAt).getTime() + 1
          : now
      );
      entry.hash = hashEntry(entry);
      await AuditLog.create(entry);
    })
    .catch((error) => {
      console.error(`AUDIT WRITE FAILED for ${entry.action}:`, error.message);
    });

  return queue;
};

/**
 * Recompute a company's chain. Returns the first entry whose stored hash or
 * back-link does not match, or ok:true when the chain is intact.
 */
const verifyChain = async (companyId) => {
  const cursor = AuditLog.find({ company: companyId || null })
    .sort({ createdAt: 1, _id: 1 })
    .lean()
    .cursor();

  let expectedPrev = GENESIS;
  let checked = 0;
  for await (const doc of cursor) {
    const recomputed = hashEntry({ ...doc, company: doc.company, actor: doc.actor });
    if (doc.prevHash !== expectedPrev || doc.hash !== recomputed) {
      return { ok: false, checked, brokenAt: String(doc._id), at: doc.createdAt };
    }
    expectedPrev = doc.hash;
    checked += 1;
  }
  return { ok: true, checked };
};

module.exports = { record, verifyChain, sanitizeMetadata };
