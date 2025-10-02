/**
 * AttendanceSettings Model
 * Stores late time calculation settings and other attendance configurations
 */

const mongoose = require('mongoose');

const attendanceSettingsSchema = new mongoose.Schema({
  // Late time calculation settings
  lateTimeSettings: {
    useCustomCutoff: {
      type: Boolean,
      default: false,
      required: true
    },
    cutoffTime: {
      type: String,
      default: "09:00",
      required: true,
      validate: {
        validator: function(v) {
          // Validate HH:MM format
          return /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/.test(v);
        },
        message: 'Cutoff time must be in HH:MM format'
      }
    },
    description: {
      type: String,
      default: 'Default late time settings'
    }
  },

  // Machine configuration settings
  machineSettings: {
    defaultIP: {
      type: String,
      default: "192.168.1.201"
    },
    connectionTimeout: {
      type: Number,
      default: 5000
    },
    syncInterval: {
      type: Number,
      default: 300000 // 5 minutes
    }
  },

  // Metadata
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  updatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  },

  // Ensure only one settings document exists
  isActive: {
    type: Boolean,
    default: true
  }
}, {
  timestamps: true,
  collection: 'attendancesettings'
});

// Index for quick lookup
attendanceSettingsSchema.index({ isActive: 1 });

// Static method to get or create settings
attendanceSettingsSchema.statics.getSettings = async function() {
  let settings = await this.findOne({ isActive: true });
  
  if (!settings) {
    // Create default settings if none exist
    settings = new this({
      lateTimeSettings: {
        useCustomCutoff: false,
        cutoffTime: "09:00",
        description: "Default late time settings - using machine defaults"
      },
      machineSettings: {
        defaultIP: "192.168.1.201",
        connectionTimeout: 5000,
        syncInterval: 300000
      },
      createdBy: null, // Will be set by calling function
      updatedBy: null,
      isActive: true
    });
  }
  
  return settings;
};

// Static method to update late time settings
attendanceSettingsSchema.statics.updateLateTimeSettings = async function(newSettings, userId) {
  let settings = await this.getSettings();
  
  // Update late time settings
  settings.lateTimeSettings = {
    ...settings.lateTimeSettings,
    ...newSettings,
    description: newSettings.useCustomCutoff 
      ? `Custom cutoff time: ${newSettings.cutoffTime}`
      : "Using machine default time rules"
  };
  
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
attendanceSettingsSchema.pre('save', async function(next) {
  if (this.isNew && this.isActive) {
    // Deactivate any existing active settings
    await this.constructor.updateMany(
      { isActive: true },
      { isActive: false }
    );
  }
  next();
});

const AttendanceSettings = mongoose.model('AttendanceSettings', attendanceSettingsSchema);

module.exports = AttendanceSettings;