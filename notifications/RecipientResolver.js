/**
 * RecipientResolver.js
 * --------------------
 * Turns an audience ("the company's admins") into concrete users, every time,
 * from the database.
 *
 * Recipients are never hardcoded and never passed in from business logic as a
 * list of numbers. A route says "this concerns the back office"; who that is
 * today - and whether an HR role exists yet - is resolved here against
 * config.recipients.adminRoles. Promote someone to admin and they start
 * receiving notifications with no deploy.
 */

const User = require("../models/User");
const config = require("./config");
const { AUDIENCE } = require("./NotificationEvents");
const logger = require("./NotificationLogger");

// Only the fields the notification layer actually needs. Fetching the whole
// document would pull leave quotas and tokens into memory for nothing.
const RECIPIENT_FIELDS = "name email phone role company status notificationPreferences";

const toRecipient = (doc) => ({
  _id: doc._id,
  name: doc.name,
  email: doc.email,
  phone: doc.phone || null,
  role: doc.role,
  company: doc.company,
  preferences: doc.notificationPreferences || {},
});

const activeFilter = () => ({
  status: { $in: config.recipients.activeStatuses },
  isActive: { $ne: false },
});

/** Every admin/HR user of a company. */
const resolveCompanyAdmins = async (companyId, { excludeUserId } = {}) => {
  if (!companyId) return [];

  const query = {
    company: companyId,
    role: { $in: config.recipients.adminRoles },
    ...activeFilter(),
  };
  if (excludeUserId) query._id = { $ne: excludeUserId };

  const docs = await User.find(query).select(RECIPIENT_FIELDS).lean();
  return docs.map(toRecipient);
};

/** One user by id, or an empty list when they are gone or deactivated. */
const resolveUser = async (userId) => {
  if (!userId) return [];

  const doc = await User.findOne({ _id: userId, ...activeFilter() })
    .select(RECIPIENT_FIELDS)
    .lean();

  return doc ? [toRecipient(doc)] : [];
};

/** Every active member of a company. */
const resolveCompany = async (companyId, { excludeUserId } = {}) => {
  if (!companyId) return [];

  const query = { company: companyId, ...activeFilter() };
  if (excludeUserId) query._id = { $ne: excludeUserId };

  const docs = await User.find(query).select(RECIPIENT_FIELDS).lean();
  return docs.map(toRecipient);
};

/**
 * Resolves whichever audience an event declares.
 * Unknown audiences resolve to nobody and are logged - a typo must not
 * accidentally broadcast to the whole company.
 */
const resolve = async (audience, context = {}) => {
  const { companyId, userId, excludeUserId } = context;

  switch (audience) {
    case AUDIENCE.COMPANY_ADMINS:
      return resolveCompanyAdmins(companyId, { excludeUserId });
    case AUDIENCE.USER:
      return resolveUser(userId);
    case AUDIENCE.COMPANY:
      return resolveCompany(companyId, { excludeUserId });
    default:
      logger.error("Unknown audience, resolved to no recipients", { audience });
      return [];
  }
};

/**
 * True when a user has not switched a channel off.
 * Absent preferences mean opted in: the field was added after these users were
 * created, and treating "unset" as "off" would silently disable the feature
 * for the entire existing user base.
 */
const acceptsChannel = (recipient, channel) => {
  const preference = recipient.preferences?.[channel];
  return preference !== false;
};

module.exports = {
  resolve,
  resolveCompanyAdmins,
  resolveUser,
  resolveCompany,
  acceptsChannel,
  RECIPIENT_FIELDS,
};
