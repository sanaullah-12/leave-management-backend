/**
 * serializeUser.js
 * ----------------
 * The one shape the API returns for "the signed-in user".
 *
 * This exists because that shape used to be hand-written at every endpoint that
 * returned a user - login, register, verify-invitation, profile, profile update,
 * avatar upload - and the copies had drifted apart:
 *
 *   - the auth endpoints omitted `phone` and `profilePicture` entirely, so a
 *     saved phone number vanished from the UI on the next session check even
 *     though it was safely stored in MongoDB;
 *   - `PUT /api/users/:id` returned the raw Mongoose document instead, with
 *     `_id` rather than `id` and `company` as an object rather than its name.
 *     Writing that into the auth context erased `user.id` and left `company`
 *     unrenderable, which broke pages after the profile was saved.
 *
 * Any endpoint whose response feeds the client's auth context must serialise
 * through here. The output is a superset - `id` and `_id`, `company` (name) and
 * `companyId` - so a consumer expecting either form keeps working.
 */

/** Populated ref, raw ObjectId, or absent - return the display name or "". */
const companyName = (company) => {
  if (!company) return "";
  if (typeof company === "string") return company;
  return company.name || "";
};

/** The company id, whether `company` is populated or still a raw ObjectId. */
const companyId = (company) => {
  if (!company) return null;
  if (typeof company === "string") return company;
  return company._id || null;
};

/**
 * @param {object} user  A User document or lean object.
 * @returns {object|null} The canonical auth-user payload.
 */
const serializeAuthUser = (user) => {
  if (!user) return null;

  const doc = typeof user.toObject === "function" ? user.toObject() : user;

  return {
    id: doc._id,
    // Kept alongside `id` so callers written against the raw document shape
    // are not broken by this consolidation.
    _id: doc._id,
    name: doc.name,
    email: doc.email,
    role: doc.role,
    employeeId: doc.employeeId,
    department: doc.department,
    position: doc.position,
    company: companyName(doc.company),
    companyId: companyId(doc.company),
    joinDate: doc.joinDate,
    // Omitting this was why a saved phone number disappeared from the profile
    // form. It is also what WhatsApp notifications are delivered to.
    phone: doc.phone || null,
    profilePicture: doc.profilePicture || null,
    notificationPreferences: doc.notificationPreferences || { whatsapp: true },
    status: doc.status,
    isActive: doc.isActive,
  };
};

module.exports = { serializeAuthUser };
