/**
 * routes/appRelease.js
 * --------------------
 * What version is running, and telling everyone when it changes.
 *
 * The announcement normally happens by itself when a new version boots, so this
 * router exists for the two cases automation cannot cover: an admin who wants
 * to see what was last announced, and an admin who wants to announce a release
 * with a written summary rather than the bare version number.
 *
 * Announcing is admin-only. Reading the current version is not - it tells an
 * employee which build they are on, which is the first thing anyone needs when
 * reporting that something looks wrong.
 */

const express = require("express");
const router = express.Router();

const { authenticateToken, authorizeRoles } = require("../middleware/auth");
const appReleaseNotifier = require("../services/appReleaseNotifier");

/**
 * GET /api/app-release
 * The running version, the last announced version, and whether they differ.
 */
router.get("/", authenticateToken, async (req, res) => {
  try {
    res.json({ success: true, ...(await appReleaseNotifier.status()) });
  } catch (error) {
    console.error("Failed to read release status:", error.message);
    res.status(500).json({
      success: false,
      code: "RELEASE_STATUS_ERROR",
      message: "Could not read the release status.",
    });
  }
});

/**
 * POST /api/app-release/announce
 *
 * Announce the running version, or a named one, to everybody.
 *
 * Without `force` this is idempotent: a version that has already been announced
 * returns `announced: false` rather than notifying anyone a second time. With
 * `force`, the per-recipient dedupe key still prevents a person being told the
 * same version twice, so the worst a repeated press can do is reach people who
 * were added since.
 */
router.post(
  "/announce",
  authenticateToken,
  authorizeRoles("admin"),
  async (req, res) => {
    try {
      const { version, notes, force } = req.body || {};

      if (version !== undefined && (typeof version !== "string" || !version.trim())) {
        return res.status(400).json({
          success: false,
          code: "BAD_VERSION",
          message: "version must be a non-empty string when supplied.",
        });
      }

      if (notes !== undefined && typeof notes !== "string") {
        return res.status(400).json({
          success: false,
          code: "BAD_NOTES",
          message: "notes must be a string when supplied.",
        });
      }

      const result = await appReleaseNotifier.announce({
        version: version ? version.trim() : undefined,
        notes: notes !== undefined ? notes.trim() : undefined,
        announcedBy: req.user._id,
        force: force === true,
      });

      res.json({ success: true, ...result });
    } catch (error) {
      console.error("Release announcement failed:", error.message);
      res.status(500).json({
        success: false,
        code: "RELEASE_ANNOUNCE_ERROR",
        message: "Could not announce the release.",
      });
    }
  }
);

module.exports = router;
