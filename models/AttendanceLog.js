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

  // Raw verification byte as the device reports it (1 fingerprint, 2 face,
  // 3 password, 4 card). The legacy CSV-imported documents store this same
  // value as "State", and attendanceDbService.normalizeLog() reads
  // `doc.state ?? doc.State` before falling back to deriving one from `type`.
  // Persisting it keeps newly synced records reading back identically to the
  // 82,668 historical ones instead of round-tripping through a lossy mapping.
  state: {
    type: Number
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

// One punch is uniquely identified by machine + employee + instant. Without
// this, every re-sync re-inserted the device's entire log, because
// bulkInsertLogs relies on duplicate-key errors to skip records it already has.
//
// The filter is partial on purpose: the legacy CSV-imported documents carry
// none of these three fields, so an unconditional unique index would see them
// all as (null, null, null) duplicates and fail to build.
attendanceLogSchema.index(
  { machineIp: 1, employeeId: 1, timestamp: 1 },
  {
    unique: true,
    partialFilterExpression: {
      machineIp: { $exists: true },
      employeeId: { $exists: true },
      timestamp: { $exists: true }
    }
  }
);

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
  if (!logs || logs.length === 0) {
    return { inserted: 0, skipped: 0, total: 0, errors: [] };
  }

  const total = logs.length;

  try {
    // ordered: false so one duplicate does not abort the remaining inserts
    const result = await this.insertMany(logs, {
      ordered: false,
      rawResult: true
    });

    const inserted = result.insertedCount ?? total;
    return { inserted, skipped: total - inserted, total, errors: [] };
  } catch (error) {
    // With ordered:false, duplicates surface as a bulk write error that still
    // reports how many documents made it in. Read the count from whichever
    // shape the driver used rather than assuming one.
    const isDuplicate =
      error.code === 11000 ||
      (Array.isArray(error.writeErrors) &&
        error.writeErrors.some((e) => e.code === 11000));

    if (isDuplicate) {
      const inserted =
        error.result?.insertedCount ??
        error.result?.nInserted ??
        error.insertedDocs?.length ??
        0;
      const skipped = total - inserted;

      return {
        inserted,
        skipped,
        total,
        errors: skipped ? [`Skipped ${skipped} duplicate records`] : []
      };
    }

    return { inserted: 0, skipped: 0, total, errors: [error.message] };
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