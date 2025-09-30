const AttendanceLog = require('../models/AttendanceLog');

class AttendanceSyncService {
  constructor() {
    this.isRunning = false;
    this.syncInterval = null;
    this.zkInstances = null; // Will be set from attendance routes
    this.machineConnections = null; // Will be set from attendance routes
  }

  // Initialize with ZKTeco instances from attendance routes
  initialize(zkInstances, machineConnections) {
    this.zkInstances = zkInstances;
    this.machineConnections = machineConnections;
    console.log('📡 Attendance sync service initialized');
  }

  // Start scheduled sync (every 15 minutes)
  startScheduledSync() {
    if (this.syncInterval) {
      console.log('📡 Attendance sync already running');
      return;
    }

    console.log('📡 Starting scheduled attendance sync (every 15 minutes)');

    // Sync immediately on start
    this.syncAllConnectedMachines();

    // Schedule regular syncs
    this.syncInterval = setInterval(() => {
      this.syncAllConnectedMachines();
    }, 15 * 60 * 1000); // 15 minutes
  }

  // Stop scheduled sync
  stopScheduledSync() {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
      console.log('📡 Stopped scheduled attendance sync');
    }
  }

  // Sync attendance logs from all connected machines
  async syncAllConnectedMachines() {
    if (!this.zkInstances || !this.machineConnections) {
      console.log('⚠️ Sync service not initialized properly');
      return;
    }

    if (this.isRunning) {
      console.log('📡 Sync already in progress, skipping...');
      return;
    }

    this.isRunning = true;
    console.log('📡 Starting attendance sync for all connected machines');

    const results = [];

    for (const [machineIp, connection] of this.machineConnections.entries()) {
      if (connection.status === 'connected') {
        try {
          console.log(`📡 Syncing attendance from machine ${machineIp}`);
          const result = await this.syncMachineAttendance(machineIp);
          results.push({ machineIp, ...result });
        } catch (error) {
          console.error(`❌ Failed to sync machine ${machineIp}:`, error.message);
          results.push({
            machineIp,
            success: false,
            error: error.message,
            synced: 0
          });
        }
      }
    }

    this.isRunning = false;
    console.log('📡 Attendance sync completed for all machines:', results);
    return results;
  }

  // Sync attendance logs from a specific machine
  async syncMachineAttendance(machineIp, companyId = null) {
    const zkInstance = this.zkInstances.get(machineIp);
    if (!zkInstance) {
      throw new Error(`ZKTeco instance not found for machine ${machineIp}`);
    }

    try {
      console.log(`📊 Syncing attendance for machine ${machineIp}`);

      // For now, return a basic success response
      return {
        success: true,
        synced: 0,
        message: 'Sync service available but not fully implemented'
      };

    } catch (error) {
      console.error(`❌ Failed to sync attendance for machine ${machineIp}:`, error);
      throw error;
    }
  }

  // Get sync status for all machines
  async getSyncStatus() {
    const status = [];

    if (!this.machineConnections) {
      return { error: 'Sync service not initialized' };
    }

    for (const [machineIp, connection] of this.machineConnections.entries()) {
      status.push({
        machineIp,
        connectionStatus: connection.status,
        isScheduledSyncRunning: !!this.syncInterval
      });
    }

    return {
      isRunning: this.isRunning,
      isScheduledSyncActive: !!this.syncInterval,
      machines: status
    };
  }

  // Manual sync trigger for specific machine
  async triggerManualSync(machineIp, companyId = null) {
    console.log(`📡 Manual sync triggered for machine ${machineIp}`);
    return await this.syncMachineAttendance(machineIp, companyId);
  }
}

// Export singleton instance
const attendanceSyncService = new AttendanceSyncService();
module.exports = attendanceSyncService;