/**
 * The company that owns the physical attendance/door device and its agent.
 *
 * There is one device and one agent per deployment, but the API is
 * multi-tenant. Everything that touches the device (door unlock, machine
 * reads, sync) or the attendance it produced, and every deployment-wide
 * setting, belongs to this company alone - not to "any admin".
 *
 * AGENT_COMPANY_ID (or DEVICE_COMPANY_ID) pins it explicitly. Without a pin a
 * single-company deployment is unambiguous; with several companies and no pin
 * this refuses to guess, and device access fails closed.
 */
const Company = require("../models/Company");

let cachedCompanyId = null;

async function resolveDeviceCompany() {
  if (cachedCompanyId) return cachedCompanyId;

  const pinned = (
    process.env.DEVICE_COMPANY_ID ||
    process.env.AGENT_COMPANY_ID ||
    ""
  ).trim();
  if (pinned) {
    cachedCompanyId = pinned;
    return cachedCompanyId;
  }

  const companies = await Company.find({}).select("_id name").limit(2).lean();

  if (companies.length === 1) {
    cachedCompanyId = companies[0]._id.toString();
    console.log(
      `Device and agent attendance belong to the only company present: ${companies[0].name}`
    );
    return cachedCompanyId;
  }

  const error = new Error(
    companies.length === 0
      ? "No company exists, so agent attendance cannot be filed."
      : "Several companies exist. Set AGENT_COMPANY_ID so agent attendance is filed under the right one."
  );
  error.code = "COMPANY_UNRESOLVED";
  throw error;
}

/** True when the user belongs to the device-owning company. */
async function isDeviceCompanyUser(user) {
  if (!user || !user.company) return false;
  const owner = await resolveDeviceCompany();
  return String(user.company._id || user.company) === String(owner);
}

module.exports = { resolveDeviceCompany, isDeviceCompanyUser };
