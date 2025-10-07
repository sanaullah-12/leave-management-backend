/**
 * Attendance Settings Service
 * Handles database operations for attendance settings
 */

const AttendanceSettings = require("../models/AttendanceSettings");

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
      console.error("❌ Failed to get attendance settings:", error);

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
      // Validate required fields
      if (newSettings.useCustomCutoff && !newSettings.cutoffTime) {
        return {
          success: false,
          message: "Cutoff time is required when using custom cutoff",
        };
      }

      // Validate time format
      if (newSettings.useCustomCutoff) {
        const timeRegex = /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/;
        if (!timeRegex.test(newSettings.cutoffTime)) {
          return {
            success: false,
            message: "Invalid time format. Use HH:MM format (e.g., 09:00)",
          };
        }
      }

      // Update settings in database
      const updatedSettings = await AttendanceSettings.updateLateTimeSettings(
        {
          useCustomCutoff: newSettings.useCustomCutoff,
          cutoffTime: newSettings.useCustomCutoff
            ? newSettings.cutoffTime
            : "09:00",
        },
        userId
      );

      console.log("✅ Late time settings updated in database:", {
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
      console.error("❌ Failed to update late time settings:", error);
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
  static async getEffectiveCutoffTime(machineWorkTime = null) {
    try {
      const result = await this.getSettings();
      const settings = result.settings;

      if (settings.useCustomCutoff) {
        console.log(`⏰ Using CUSTOM cutoff time: ${settings.cutoffTime}`);
        return settings.cutoffTime;
      }

      if (machineWorkTime) {
        console.log(`⏰ Using MACHINE cutoff time: ${machineWorkTime}`);
        return machineWorkTime;
      }

      console.log(`⏰ Using DEFAULT cutoff time: ${settings.cutoffTime}`);
      return settings.cutoffTime;
    } catch (error) {
      console.error("❌ Error getting effective cutoff time:", error);
      console.log(`⏰ Using FALLBACK cutoff time: 09:00`);
      return "09:00";
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
      console.error("❌ Failed to get enhanced settings:", error);

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
        console.log("✅ Initialized default attendance settings");
        return defaultSettings;
      }

      return existingSettings;
    } catch (error) {
      console.error("❌ Failed to initialize default settings:", error);
      throw error;
    }
  }
}

module.exports = AttendanceSettingsService;
