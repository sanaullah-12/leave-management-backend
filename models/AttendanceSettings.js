/**
 * AttendanceSettings Model
 * Stores late time calculation settings and other attendance configurations
 */

const mongoose = require("mongoose");

const attendanceSettingsSchema = new mongoose.Schema(
  {
    // Late time calculation settings
    lateTimeSettings: {
      // Which rule decides "late". The two named presets are the office's
      // agreed arrival times; "custom" defers to cutoffTime below, which is
      // what installations configured before the presets existed still use.
      //   flexible - the grace arrival time
      //   strict   - the hard deadline
      policy: {
        type: String,
        enum: ["flexible", "strict", "custom"],
        default: "flexible",
      },
      flexibleCutoff: {
        type: String,
        default: "09:15",
        validate: {
          validator: (v) => /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/.test(v),
          message: "Flexible cutoff must be in HH:MM format",
        },
      },
      strictCutoff: {
        type: String,
        default: "09:30",
        validate: {
          validator: (v) => /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/.test(v),
          message: "Strict cutoff must be in HH:MM format",
        },
      },
      useCustomCutoff: {
        type: Boolean,
        default: false,
        required: true,
      },
      cutoffTime: {
        type: String,
        default: "09:00",
        required: true,
        validate: {
          validator: function (v) {
            // Validate HH:MM format
            return /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/.test(v);
          },
          message: "Cutoff time must be in HH:MM format",
        },
      },
      description: {
        type: String,
        default: "Default late time settings",
      },
    },

    /**
     * What happens when someone is neither at the office nor accounted for.
     *
     * After the cutoff on a working day, an employee with no punch, no leave
     * and no work-from-home request has not told anyone anything - so the day
     * is recorded as annual leave with a reason saying exactly that. It stays
     * reversible: an approved backdated WFH request revokes it.
     */
    unreportedAbsenceSettings: {
      enabled: {
        type: Boolean,
        default: true,
      },
      /** Office time after which an unexplained day is converted. */
      cutoffTime: {
        type: String,
        default: "14:00",
        validate: {
          validator: (v) => /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/.test(v),
          message: "Cutoff time must be in HH:MM format",
        },
      },
      /** The leave type an unreported day is charged to. */
      leaveType: {
        type: String,
        enum: ["annual", "casual", "sick", "unpaid"],
        default: "annual",
      },
      /** Used instead when the primary type has no balance left. */
      fallbackLeaveType: {
        type: String,
        enum: ["unpaid", "annual", "casual"],
        default: "unpaid",
      },
    },

    // Machine configuration settings
    machineSettings: {
      defaultIP: {
        type: String,
        default: "192.168.1.201",
      },
      connectionTimeout: {
        type: Number,
        default: 5000,
      },
      syncInterval: {
        type: Number,
        default: 300000, // 5 minutes
      },
    },

    // Metadata
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
    updatedAt: {
      type: Date,
      default: Date.now,
    },

    // Ensure only one settings document exists
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
    collection: "attendancesettings",
  }
);

// Index for quick lookup
attendanceSettingsSchema.index({ isActive: 1 });

// Static method to get or create settings
attendanceSettingsSchema.statics.getSettings = async function () {
  let settings = await this.findOne({ isActive: true });

  if (!settings) {
    // Create default settings if none exist
    settings = new this({
      lateTimeSettings: {
        useCustomCutoff: false,
        cutoffTime: "09:00",
        description: "Default late time settings - using machine defaults",
      },
      machineSettings: {
        defaultIP: "192.168.1.201",
        connectionTimeout: 5000,
        syncInterval: 300000,
      },
      createdBy: null, // Will be set by calling function
      updatedBy: null,
      isActive: true,
    });
  }

  return settings;
};

// Static method to update late time settings
attendanceSettingsSchema.statics.updateLateTimeSettings = async function (
  newSettings,
  userId
) {
  let settings = await this.getSettings();

  // Merge onto the stored values so a caller that sends only the policy does
  // not blank out the configured preset times.
  const merged = {
    ...(settings.lateTimeSettings?.toObject
      ? settings.lateTimeSettings.toObject()
      : settings.lateTimeSettings),
    ...newSettings,
  };

  const describe = () => {
    if (merged.policy === "custom" || merged.useCustomCutoff) {
      return `Custom cutoff time: ${merged.cutoffTime}`;
    }
    return merged.policy === "strict"
      ? `Strict arrival deadline: ${merged.strictCutoff}`
      : `Flexible arrival time: ${merged.flexibleCutoff}`;
  };

  settings.lateTimeSettings = { ...merged, description: describe() };

  settings.updatedBy = userId;
  settings.updatedAt = new Date();

  // Set createdBy if this is a new document
  if (!settings.createdBy) {
    settings.createdBy = userId;
  }

  await settings.save();
  return settings;
};

// Pre-save middleware to ensure only one active settings document
attendanceSettingsSchema.pre("save", async function (next) {
  if (this.isNew && this.isActive) {
    // Deactivate any existing active settings
    await this.constructor.updateMany({ isActive: true }, { isActive: false });
  }
  next();
});

const AttendanceSettings = mongoose.model(
  "AttendanceSettings",
  attendanceSettingsSchema
);

module.exports = AttendanceSettings;
