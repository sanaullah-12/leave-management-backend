const mongoose = require('mongoose');

const attendanceLogSchema = new mongoose.Schema({
  // Machine and employee identification
  machineIp: {
    type: String,
    required: true,
    index: true
  },

  employeeId: {
    type: String,
    required: true,
    index: true
  },

  machineUserId: {
    type: String,
    required: true
  },

  // Attendance data
  timestamp: {
    type: Date,
    required: true,
    index: true
  },

  date: {
    type: String, // YYYY-MM-DD format for easy querying
    required: true,
    index: true
  },

  type: {
    type: String, // check-in, check-out, break-in, break-out, etc.
    default: 'unknown'
  },

  mode: {
    type: String, // biometric mode (fingerprint, card, password, etc.)
    default: 'unknown'
  },

  // Status tracking
  processed: {
    type: Boolean,
    default: false,
    index: true
  },

  // Raw data from ZKTeco device
  rawData: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },

  // Company association for multi-tenancy
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: true,
    index: true
  },

  // Sync metadata
  syncedAt: {
    type: Date,
    default: Date.now
  },

  lastModified: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

// Compound indexes for efficient querying
attendanceLogSchema.index({ machineIp: 1, employeeId: 1, date: 1 });
attendanceLogSchema.index({ company: 1, date: 1 });
attendanceLogSchema.index({ machineIp: 1, timestamp: 1 });
attendanceLogSchema.index({ employeeId: 1, timestamp: 1 });

// Update lastModified on save
attendanceLogSchema.pre('save', function(next) {
  this.lastModified = new Date();

  // Auto-generate date field from timestamp
  if (this.timestamp && !this.date) {
    this.date = this.timestamp.toISOString().split('T')[0];
  }

  next();
});

// Static methods for efficient querying
attendanceLogSchema.statics.getEmployeeAttendance = async function(machineIp, employeeId, startDate, endDate, companyId) {
  const query = {
    machineIp,
    employeeId,
    company: companyId,
    date: {
      $gte: startDate,
      $lte: endDate
    }
  };

  return this.find(query)
    .sort({ timestamp: 1 })
    .lean();
};

attendanceLogSchema.statics.getLastSyncTime = async function(machineIp, companyId) {
  const lastLog = await this.findOne({
    machineIp,
    company: companyId
  })
  .sort({ timestamp: -1 })
  .lean();

  return lastLog ? lastLog.timestamp : null;
};

attendanceLogSchema.statics.bulkInsertLogs = async function(logs) {
  if (!logs || logs.length === 0) return { inserted: 0, errors: [] };

  try {
    // Use ordered: false to continue on duplicates
    const result = await this.insertMany(logs, {
      ordered: false,
      rawResult: true
    });

    return {
      inserted: result.insertedCount || logs.length,
      errors: []
    };
  } catch (error) {
    if (error.code === 11000) {
      // Handle duplicate key errors
      const inserted = error.result?.nInserted || 0;
      return {
        inserted,
        errors: [`Skipped ${logs.length - inserted} duplicate records`]
      };
    }

    return {
      inserted: 0,
      errors: [error.message]
    };
  }
};

// Instance methods
attendanceLogSchema.methods.toAttendanceRecord = function() {
  return {
    date: this.date,
    timestamp: this.timestamp,
    type: this.type,
    mode: this.mode,
    employeeId: this.employeeId,
    machineId: this.machineUserId,
    rawData: this.rawData
  };
};

const AttendanceLog = mongoose.model('AttendanceLog', attendanceLogSchema);

module.exports = AttendanceLog;