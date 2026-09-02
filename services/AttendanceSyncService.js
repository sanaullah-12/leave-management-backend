const BiometricService = require('./BiometricService');
const AttendanceLog = require('../models/AttendanceLog');

// ZKTeco numeric punch states mapped onto the AttendanceLog "type" strings.
const STATE_TO_TYPE = {
  0: 'check-in',
  1: 'check-out',
  2: 'break-out',
  3: 'break-in',
  4: 'ot-in',
  5: 'ot-out',
};

class AttendanceSyncService {
  /**
   * Normalise device log records and write them to the database.
   *
   * Split out from syncAttendanceLogs so that logs collected somewhere other
   * than this process - specifically a Local Agent on the office LAN, which is
   * the only machine that can reach the device in production - land in exactly
   * the same shape as a direct sync. Both paths must produce identical
   * documents or the deduplication index cannot recognise a repeat punch.
   *
   * Deduplication is the partial unique index on
   * {machineIp, employeeId, timestamp}: bulkInsertLogs relies on the resulting
   * duplicate-key errors to skip records already stored, so re-sending the
   * whole device log is safe and inserts nothing new.
   *
   * @param {string} deviceIp   Device the logs came from.
   * @param {string} companyId  Owning company.
   * @param {Array}  deviceLogs Records as BiometricService formats them.
   */
  static async persistDeviceLogs(deviceIp, companyId, deviceLogs) {
    if (!Array.isArray(deviceLogs) || deviceLogs.length === 0) {
      return { inserted: 0, skipped: 0, total: 0, errors: [] };
    }

    const transformedLogs = [];
    const rejected = [];

    for (const log of deviceLogs) {
      const timestamp = new Date(log.timestamp);

      // A record with an unparseable timestamp cannot be deduplicated and
      // would corrupt date-range queries, so drop it rather than store it.
      if (Number.isNaN(timestamp.getTime())) {
        rejected.push(`Invalid timestamp: ${JSON.stringify(log.timestamp)}`);
        continue;
      }

      // employeeId must be the enrolled User ID (log.userId), not the device
      // record slot (log.uid) - uid is 0 on virtually every real record.
      transformedLogs.push({
        machineIp: deviceIp,
        employeeId: String(log.userId ?? log.uid ?? 'unknown'),
        machineUserId: String(log.uid ?? log.userId ?? 'unknown'),
        timestamp,
        date: timestamp.toISOString().split('T')[0],
        // The device reports the punch kind as a numeric state. Persist it as
        // the schema's type string, otherwise every record reads back as
        // "Unknown" - BiometricService defaults log.type to "attendance",
        // which carries no punch information at all.
        type: STATE_TO_TYPE[log.state] || log.type || 'unknown',
        mode: log.mode || 'unknown',
        // Keep the device's own verification byte. The read path prefers it
        // over deriving a state from `type`, which is what makes a synced
        // record indistinguishable from a historically imported one.
        state: typeof log.state === 'number' ? log.state : undefined,
        rawData: log.rawData || log,
        company: companyId,
        syncedAt: new Date()
      });
    }

    const result = await AttendanceLog.bulkInsertLogs(transformedLogs);

    return {
      ...result,
      total: deviceLogs.length,
      rejected: rejected.length,
      errors: [...(result.errors || []), ...rejected]
    };
  }

  /**
   * Sync attendance logs from ZKTeco device to database
   * @param {string} deviceIp - Device IP address
   * @param {string} companyId - Company MongoDB ID
   * @param {object} options - Sync options
   * @returns {Promise<object>} Sync result
   */
  static async syncAttendanceLogs(deviceIp, companyId, options = {}) {
    const {
      startDate = null, // Optional: only sync from this date
      endDate = null,   // Optional: only sync until this date
      force = false      // Force full sync even if recently synced
    } = options;

    console.log(`\n${'='.repeat(70)}`);
    console.log(`ATTENDANCE SYNC: ${deviceIp} -> Database`);
    console.log(`${'='.repeat(70)}\n`);

    const biometricService = new BiometricService(deviceIp, 4370);
    const syncStartTime = Date.now();

    try {
      // Step 1: Connect to device
      console.log('Step 1: Connecting to device...');
      await biometricService.connect();
      console.log('Connected\n');

      // Step 2: Fetch logs from device
      console.log('Step 2: Fetching attendance logs from device...');
      if (startDate || endDate) {
        console.log(`Date range: ${startDate || 'beginning'} to ${endDate || 'now'}`);
      } else {
        console.log('Fetching ALL logs');
      }

      const deviceLogs = await biometricService.getAttendanceLogs(startDate, endDate);
      console.log(`Retrieved ${deviceLogs.length} logs from device\n`);

      // Step 3: Disconnect from device
      await biometricService.disconnect();
      console.log('Disconnected from device\n');

      if (deviceLogs.length === 0) {
        console.log('No logs to sync');
        return {
          success: true,
          deviceIp,
          companyId,
          inserted: 0,
          skipped: 0,
          total: 0,
          duration: ((Date.now() - syncStartTime) / 1000).toFixed(2)
        };
      }

      // Step 4 and 5: Transform and insert.
      const result = await this.persistDeviceLogs(deviceIp, companyId, deviceLogs);

      const duration = ((Date.now() - syncStartTime) / 1000).toFixed(2);

      console.log(`\n${'='.repeat(70)}`);
      console.log('SYNC COMPLETE');
      console.log(`${'='.repeat(70)}`);
      console.log(`Inserted: ${result.inserted}`);
      console.log(`⏭ Skipped (duplicates): ${result.skipped}`);
      console.log(`Total: ${result.total}`);
      console.log(`⏱ Duration: ${duration}s`);
      console.log(`${'='.repeat(70)}\n`);

      return {
        success: true,
        deviceIp,
        companyId,
        inserted: result.inserted,
        updated: result.updated || 0,
        skipped: result.skipped,
        total: result.total,
        duration,
        syncedAt: new Date().toISOString()
      };

    } catch (error) {
      console.error('\n Sync failed:', error.message);

      // Ensure device is disconnected
      try {
        await biometricService.disconnect();
      } catch (e) {
        // Ignore
      }

      throw error;
    }
  }

  /**
   * Get attendance logs from database (not from device)
   * @param {string} deviceIp - Device IP address
   * @param {string} companyId - Company MongoDB ID
   * @param {string} startDate - Start date (YYYY-MM-DD)
   * @param {string} endDate - End date (YYYY-MM-DD)
   * @returns {Promise<Array>} Attendance logs from database
   */
  static async getAttendanceFromDatabase(deviceIp, companyId, startDate, endDate) {
    console.log(`Querying database for attendance: ${deviceIp}, ${startDate} to ${endDate}`);

    const query = {
      machineIp: deviceIp,
      company: companyId,
      date: {
        $gte: startDate,
        $lte: endDate
      }
    };

    const logs = await AttendanceLog.find(query)
      .sort({ timestamp: 1 })
      .lean();

    console.log(`Found ${logs.length} logs in database`);

    return logs.map(log => ({
      uid: log.employeeId || log.machineUserId,
      timestamp: log.timestamp.toISOString(),
      date: log.date,
      type: log.type,
      mode: log.mode,
      ip: log.machineIp,
      rawData: log.rawData
    }));
  }

  /**
   * Get last sync time for a device
   * @param {string} deviceIp - Device IP address
   * @param {string} companyId - Company MongoDB ID
   * @returns {Promise<Date|null>} Last sync timestamp
   */
  static async getLastSyncTime(deviceIp, companyId) {
    const lastLog = await AttendanceLog.findOne({
      machineIp: deviceIp,
      company: companyId
    })
    .sort({ timestamp: -1 })
    .select('timestamp syncedAt')
    .lean();

    return lastLog;
  }

  /**
   * Get sync statistics
   * @param {string} deviceIp - Device IP address
   * @param {string} companyId - Company MongoDB ID
   * @returns {Promise<object>} Sync statistics
   */
  static async getSyncStats(deviceIp, companyId) {
    const query = { machineIp: deviceIp, company: companyId };

    const [totalLogs, lastSync, oldestLog, newestLog] = await Promise.all([
      AttendanceLog.countDocuments(query),
      AttendanceLog.findOne(query).sort({ syncedAt: -1 }).select('syncedAt').lean(),
      AttendanceLog.findOne(query).sort({ timestamp: 1 }).select('timestamp date').lean(),
      AttendanceLog.findOne(query).sort({ timestamp: -1 }).select('timestamp date').lean()
    ]);

    return {
      deviceIp,
      companyId,
      totalLogs,
      lastSyncTime: lastSync?.syncedAt || null,
      oldestRecord: oldestLog ? { timestamp: oldestLog.timestamp, date: oldestLog.date } : null,
      newestRecord: newestLog ? { timestamp: newestLog.timestamp, date: newestLog.date } : null
    };
  }

  /**
   * Incremental sync - only fetch new logs since last sync
   * @param {string} deviceIp - Device IP address
   * @param {string} companyId - Company MongoDB ID
   * @returns {Promise<object>} Sync result
   */
  static async incrementalSync(deviceIp, companyId) {
    const lastSync = await this.getLastSyncTime(deviceIp, companyId);

    let startDate = null;

    if (lastSync && lastSync.timestamp) {
      // Sync from last record date (overlap 1 day for safety)
      const lastDate = new Date(lastSync.timestamp);
      lastDate.setDate(lastDate.getDate() - 1); // Go back 1 day
      startDate = lastDate.toISOString().split('T')[0];
      console.log(`Incremental sync from ${startDate} (last sync: ${lastSync.timestamp})`);
    } else {
      console.log('First sync - fetching all logs');
    }

    return await this.syncAttendanceLogs(deviceIp, companyId, {
      startDate,
      endDate: null // Up to current date
    });
  }
}

module.exports = AttendanceSyncService;