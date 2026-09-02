/**
 * Attendance Settings Service
 * Handles database operations for attendance settings
 */

const AttendanceSettings = require("../models/AttendanceSettings");

/** Falls back to these when no settings document has been saved yet. */
const DEFAULTS = {
  policy: "flexible",
  flexibleCutoff: "09:15",
  strictCutoff: "09:30",
  cutoffTime: "09:00",
};

const TIME_PATTERN = /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/;

/**
 * Turn a policy name into the time it stands for.
 * Returns null for anything unrecognised so the caller can fall through to the
 * stored configuration rather than silently judging people against a guess.
 */
function cutoffForPolicy(policy, settings = {}) {
  if (policy === "flexible") return settings.flexibleCutoff || DEFAULTS.flexibleCutoff;
  if (policy === "strict") return settings.strictCutoff || DEFAULTS.strictCutoff;
  // A bare HH:MM is accepted so a caller can preview an arbitrary time.
  if (typeof policy === "string" && TIME_PATTERN.test(policy)) return policy;
  return null;
}

class AttendanceSettingsService {
  /**
   * Get current attendance settings with proper fallbacks
   */
  static async getSettings() {
    try {
      const settings = await AttendanceSettings.getSettings();
      return {
        success: true,
        settings: settings.lateTimeSettings,
        machineSettings: settings.machineSettings,
        metadata: {
          updatedAt: settings.updatedAt,
          updatedBy: settings.updatedBy,
        },
      };
    } catch (error) {
      console.error("Failed to get attendance settings:", error);

      // Return safe defaults on error
      return {
        success: false,
        settings: {
          useCustomCutoff: false,
          cutoffTime: "09:00",
          description: "Default settings (database error)",
        },
        error: error.message,
      };
    }
  }

  /**
   * Update late time settings and persist to database
   */
  static async updateLateTimeSettings(newSettings, userId) {
    try {
      const patch = {};

      if (newSettings.policy !== undefined) {
        if (!["flexible", "strict", "custom"].includes(newSettings.policy)) {
          return {
            success: false,
            message: 'policy must be one of "flexible", "strict" or "custom"',
          };
        }
        patch.policy = newSettings.policy;
        // Keep the legacy flag consistent with the policy so anything still
        // reading useCustomCutoff agrees with anything reading policy.
        patch.useCustomCutoff = newSettings.policy === "custom";
      }

      // Each preset time is optional on update: an admin switching policy sends
      // only the policy, and blanking the other preset would be wrong.
      for (const field of ["flexibleCutoff", "strictCutoff", "cutoffTime"]) {
        if (newSettings[field] === undefined) continue;
        if (!TIME_PATTERN.test(newSettings[field])) {
          return {
            success: false,
            message: `Invalid ${field}. Use HH:MM format (e.g., 09:15)`,
          };
        }
        patch[field] = newSettings[field];
      }

      // Legacy callers send useCustomCutoff without a policy.
      if (newSettings.policy === undefined && newSettings.useCustomCutoff !== undefined) {
        patch.useCustomCutoff = newSettings.useCustomCutoff;
        patch.policy = newSettings.useCustomCutoff ? "custom" : "flexible";
      }

      const effectivelyCustom =
        patch.policy === "custom" || patch.useCustomCutoff === true;
      if (effectivelyCustom && !patch.cutoffTime) {
        const current = await this.getSettings();
        if (!current.settings?.cutoffTime) {
          return {
            success: false,
            message: "Cutoff time is required when using a custom cutoff",
          };
        }
      }

      // Update settings in database
      const updatedSettings = await AttendanceSettings.updateLateTimeSettings(
        patch,
        userId
      );

      console.log("Late time settings updated in database:", {
        policy: updatedSettings.lateTimeSettings.policy,
        flexibleCutoff: updatedSettings.lateTimeSettings.flexibleCutoff,
        strictCutoff: updatedSettings.lateTimeSettings.strictCutoff,
        useCustomCutoff: updatedSettings.lateTimeSettings.useCustomCutoff,
        cutoffTime: updatedSettings.lateTimeSettings.cutoffTime,
        updatedBy: updatedSettings.updatedBy,
      });

      return {
        success: true,
        message: "Late time settings updated successfully",
        settings: updatedSettings.lateTimeSettings,
      };
    } catch (error) {
      console.error("Failed to update late time settings:", error);
      return {
        success: false,
        message: "Failed to update late time settings",
        error: error.message,
      };
    }
  }

  /**
   * Get effective cutoff time for late calculation
   * Priority: Custom Settings > Machine Settings > Default (09:00)
   */
  static async getEffectiveCutoffTime(machineWorkTime = null, options = {}) {
    const resolved = await this.resolveCutoff(machineWorkTime, options);
    return resolved.cutoffTime;
  }

  /**
   * Work out which time decides "late", and say where it came from.
   *
   * Order of precedence:
   *   1. previewPolicy - a caller asking "how would this look under 09:30?".
   *      It never changes what is stored, so an employee can compare the two
   *      office times without being able to move their own bar.
   *   2. the saved policy - flexible or strict, the admin's decision, which is
   *      the official rule for everyone.
   *   3. a custom cutoff configured before the presets existed.
   *   4. the machine's own work time, then a hard default.
   *
   * @param {string|null} machineWorkTime
   * @param {{previewPolicy?: string}} options
   */
  static async resolveCutoff(machineWorkTime = null, options = {}) {
    try {
      const result = await this.getSettings();
      const settings = { ...DEFAULTS, ...(result.settings || {}) };

      const official =
        settings.policy === "custom" || settings.useCustomCutoff
          ? settings.cutoffTime
          : cutoffForPolicy(settings.policy, settings) ||
            machineWorkTime ||
            settings.cutoffTime;

      const officialPolicy =
        settings.policy === "custom" || settings.useCustomCutoff
          ? "custom"
          : settings.policy;

      const preview = cutoffForPolicy(options.previewPolicy, settings);
      if (preview && preview !== official) {
        return {
          cutoffTime: preview,
          policy: options.previewPolicy,
          officialCutoffTime: official,
          officialPolicy,
          isPreview: true,
          flexibleCutoff: settings.flexibleCutoff,
          strictCutoff: settings.strictCutoff,
        };
      }

      return {
        cutoffTime: official,
        policy: officialPolicy,
        officialCutoffTime: official,
        officialPolicy,
        isPreview: false,
        flexibleCutoff: settings.flexibleCutoff,
        strictCutoff: settings.strictCutoff,
      };
    } catch (error) {
      console.error("Error resolving cutoff time:", error);
      return {
        cutoffTime: DEFAULTS.flexibleCutoff,
        policy: "flexible",
        officialCutoffTime: DEFAULTS.flexibleCutoff,
        officialPolicy: "flexible",
        isPreview: false,
        flexibleCutoff: DEFAULTS.flexibleCutoff,
        strictCutoff: DEFAULTS.strictCutoff,
      };
    }
  }

  /**
   * Get settings with machine information
   */
  static async getSettingsWithMachineInfo(machineSettings = null) {
    try {
      const result = await this.getSettings();

      if (!result.success) {
        throw new Error(result.error);
      }

      const settings = result.settings;

      // Enhance settings with machine information
      const enhancedSettings = {
        ...settings,
        machineDefault: !settings.useCustomCutoff,
        description: settings.useCustomCutoff
          ? `Custom cutoff time: ${settings.cutoffTime}`
          : machineSettings
          ? `Using time rules from ZKTeco machine ${machineSettings.ip}`
          : "Using default time rules (no machine connected)",
        machineSettings: machineSettings,
      };

      return {
        success: true,
        settings: enhancedSettings,
      };
    } catch (error) {
      console.error("Failed to get enhanced settings:", error);

      // Return safe defaults
      return {
        success: false,
        settings: {
          useCustomCutoff: false,
          cutoffTime: "09:00",
          machineDefault: true,
          description: "Default time rules (error loading settings)",
          machineSettings: null,
        },
        error: error.message,
      };
    }
  }

  /**
   * Initialize default settings if none exist
   */
  static async initializeDefaultSettings(userId = null) {
    try {
      const existingSettings = await AttendanceSettings.findOne({
        isActive: true,
      });

      if (!existingSettings) {
        const defaultSettings = new AttendanceSettings({
          lateTimeSettings: {
            useCustomCutoff: false,
            cutoffTime: "09:00",
            description: "Default late time settings",
          },
          machineSettings: {
            defaultIP: "192.168.1.201",
            connectionTimeout: 5000,
            syncInterval: 300000,
          },
          createdBy: userId,
          updatedBy: userId,
          isActive: true,
        });

        await defaultSettings.save();
        console.log("Initialized default attendance settings");
        return defaultSettings;
      }

      return existingSettings;
    } catch (error) {
      console.error("Failed to initialize default settings:", error);
      throw error;
    }
  }
}

module.exports = AttendanceSettingsService;
