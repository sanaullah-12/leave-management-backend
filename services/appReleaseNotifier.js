/**
 * appReleaseNotifier.js
 * ---------------------
 * Tells everyone when Nexora itself has changed.
 *
 * Every other notification in this system is about a person's own work - their
 * leave, their arrival, a request waiting on them. This one is about the
 * product, so it goes to the whole company: an employee and an admin are
 * equally affected by a release, and neither of them is watching a deploy log.
 *
 *   server boots -> is this version already announced?
 *                     |
 *                     no
 *                     |
 *              claim the version   <- unique index; only one instance wins
 *                     |
 *        NotificationService.dispatch(APP_UPDATE_RELEASED, audience: COMPANY)
 *                     |
 *          +----------+----------+
 *          |                     |
 *   in-app + Socket.IO      browser push
 *
 * Announced once per version, never once per restart. A deployed server
 * restarts for reasons that are not news - a crash, a scale event, a platform
 * migration - and announcing on any of those would train people to ignore the
 * one notification that means something.
 */

const AppRelease = require("../models/AppRelease");
const Company = require("../models/Company");
const { NotificationService, NOTIFICATION_EVENTS } = require("../notifications");

/**
 * The version being run.
 *
 * APP_RELEASE_VERSION first so a deployment can stamp something more meaningful
 * than a package.json nobody remembers to bump - a git SHA, a build number, a
 * date. Falling back to package.json means the feature still works with no
 * configuration at all.
 */
function currentVersion() {
  const stamped = String(process.env.APP_RELEASE_VERSION || "").trim();
  if (stamped) return stamped;

  try {
    return String(require("../package.json").version || "").trim() || null;
  } catch (_) {
    return null;
  }
}

/** Optional one-line summary of what changed, shown in the notification. */
function currentNotes() {
  const notes = String(process.env.APP_RELEASE_NOTES || "").trim();
  return notes || null;
}

/** Off by default would be wrong for a product notification, but say so. */
const ENABLED =
  String(process.env.APP_UPDATE_NOTIFICATIONS || "true").trim().toLowerCase() !==
  "false";

/**
 * Announce one version to one company.
 *
 * The dedupe key is a function of the recipient because the audience is the
 * whole company: a single shared key is unique across the entire Notification
 * collection, so it would let exactly one person be notified and reject
 * everybody else as a duplicate.
 */
async function announceToCompany(company, { version, notes }) {
  return NotificationService.dispatch({
    event: NOTIFICATION_EVENTS.APP_UPDATE_RELEASED,
    companyId: company._id,
    payload: { version, notes, companyName: company.name },
    dedupeKey: (recipient) => `release:${version}:${recipient._id}`,
  });
}

/**
 * Announce a version to every company, if it has not been announced already.
 *
 * @param {{version?: string, notes?: string, announcedBy?: string, force?: boolean}} options
 * @returns {Promise<object>} What happened, for the route and for the boot log.
 */
async function announce(options = {}) {
  const version = options.version || currentVersion();
  const notes = options.notes !== undefined ? options.notes : currentNotes();

  if (!version) {
    return { announced: false, reason: "no_version", version: null, recipients: 0 };
  }

  // `force` re-announces a version that has already gone out. Only an admin
  // pressing the button reaches this, and the per-recipient dedupe key still
  // stops anyone being told the same version twice.
  if (!options.force) {
    const claimed = await AppRelease.claim({
      version,
      notes,
      announcedBy: options.announcedBy,
    });

    if (!claimed) {
      return {
        announced: false,
        reason: "already_announced",
        version,
        recipients: 0,
      };
    }
  }

  const companies = await Company.find({}).select("_id name").lean();
  let recipients = 0;
  let pushSent = 0;

  for (const company of companies) {
    try {
      const summary = await announceToCompany(company, { version, notes });
      recipients += summary.recipientCount || 0;
      pushSent += summary.push?.sent || 0;
    } catch (error) {
      // One tenant failing must not stop the rest being told.
      console.error(
        `Release announcement failed for company ${company._id}:`,
        error.message
      );
    }
  }

  await AppRelease.updateOne({ version }, { $set: { recipientCount: recipients } });

  console.log(
    `Announced Nexora ${version} to ${recipients} user(s) across ` +
      `${companies.length} company/companies (${pushSent} browser push sent)`
  );

  return { announced: true, version, notes, recipients, pushSent };
}

/**
 * Called once after the database is connected.
 *
 * Deliberately fail-safe and deliberately not awaited by the boot sequence: a
 * server that cannot announce a release must still start and still serve
 * attendance, leave and everything else.
 */
async function announceOnBoot() {
  if (!ENABLED) return { announced: false, reason: "disabled" };

  try {
    const result = await announce();
    if (!result.announced && result.reason === "already_announced") {
      console.log(`Nexora ${result.version} was already announced - staying quiet.`);
    }
    return result;
  } catch (error) {
    console.error("Release announcement on boot failed:", error.message);
    return { announced: false, reason: "error", error: error.message };
  }
}

/** What the admin screen shows: what is running, and what was last announced. */
async function status() {
  const latest = await AppRelease.latest();
  const version = currentVersion();

  return {
    version,
    notes: currentNotes(),
    enabled: ENABLED,
    lastAnnounced: latest
      ? {
          version: latest.version,
          notes: latest.notes,
          announcedAt: latest.announcedAt,
          recipientCount: latest.recipientCount,
        }
      : null,
    pendingAnnouncement: Boolean(version && (!latest || latest.version !== version)),
  };
}

module.exports = {
  announce,
  announceOnBoot,
  status,
  currentVersion,
};
