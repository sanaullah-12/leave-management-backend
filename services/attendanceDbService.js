const mongoose = require('mongoose');

/**
 * Service for fetching attendance data from MongoDB database instead of ZK machines
 * This service replaces the ZKTeco machine-based data fetching with database queries
 */
class AttendanceDbService {
  
  /**
   * Get attendance logs for a specific employee from database
   * @param {string} employeeId - Employee ID to fetch attendance for
   * @param {string} startDate - Start date (YYYY-MM-DD)
   * @param {string} endDate - End date (YYYY-MM-DD)
   * @param {string} companyId - Company ID for multi-tenancy (optional for now)
   * @returns {Object} Attendance data with success flag
   */
  static async getEmployeeAttendance(employeeId, startDate, endDate, companyId = null) {
    try {
      console.log(`📊 Fetching attendance from database for employee ${employeeId} (${startDate} to ${endDate})`);

      // Get the attendancelogs collection directly
      const attendanceCollection = mongoose.connection.db.collection('attendancelogs');
      
      // Build query
      const query = {
        id: parseInt(employeeId), // id field is the employee identifier
        timestamp: {
          $gte: new Date(startDate + 'T00:00:00.000Z'),
          $lte: new Date(endDate + 'T23:59:59.999Z')
        }
      };

      console.log('🔍 Database query:', JSON.stringify(query, null, 2));

      // Fetch attendance logs
      const attendanceLogs = await attendanceCollection
        .find(query)
        .sort({ timestamp: 1 })
        .toArray();

      console.log(`✅ Found ${attendanceLogs.length} attendance records`);

      // Transform the data to match expected format
      const transformedLogs = attendanceLogs.map(log => ({
        uid: log.uid,
        userId: log.id, // Map id to userId for backward compatibility
        employeeId: log.id.toString(),
        timestamp: log.timestamp,
        state: log.state,
        stateText: this.getStateText(log.state),
        type: this.getAttendanceType(log.state),
        date: log.timestamp.toISOString().split('T')[0],
        time: log.timestamp.toISOString().split('T')[1].substr(0, 8),
        rawData: {
          uid: log.uid,
          id: log.id,
          state: log.state,
          timestamp: log.timestamp
        }
      }));

      return {
        success: true,
        attendance: transformedLogs,
        employeeId,
        dateRange: { startDate, endDate },
        totalRecords: transformedLogs.length,
        source: 'database'
      };

    } catch (error) {
      console.error(`❌ Database attendance fetch failed:`, error);
      return {
        success: false,
        error: error.message,
        attendance: []
      };
    }
  }

  /**
   * Get attendance for multiple employees in a date range
   * @param {Array} employeeIds - Array of employee IDs
   * @param {string} startDate - Start date (YYYY-MM-DD)
   * @param {string} endDate - End date (YYYY-MM-DD)
   * @param {string} companyId - Company ID for multi-tenancy (optional for now)
   * @returns {Object} Attendance data grouped by employee
   */
  static async getMultipleEmployeeAttendance(employeeIds, startDate, endDate, companyId = null) {
    try {
      console.log(`📊 Fetching attendance from database for ${employeeIds.length} employees (${startDate} to ${endDate})`);

      // Get the attendancelogs collection directly
      const attendanceCollection = mongoose.connection.db.collection('attendancelogs');
      
      // Convert employeeIds to integers
      const employeeIdInts = employeeIds.map(id => parseInt(id));
      
      // Build query
      const query = {
        id: { $in: employeeIdInts },
        timestamp: {
          $gte: new Date(startDate + 'T00:00:00.000Z'),
          $lte: new Date(endDate + 'T23:59:59.999Z')
        }
      };

      console.log('🔍 Database query:', JSON.stringify(query, null, 2));

      // Fetch attendance logs
      const attendanceLogs = await attendanceCollection
        .find(query)
        .sort({ id: 1, timestamp: 1 })
        .toArray();

      console.log(`✅ Found ${attendanceLogs.length} attendance records`);

      // Group by employee ID
      const groupedAttendance = {};
      
      attendanceLogs.forEach(log => {
        const empId = log.id.toString();
        if (!groupedAttendance[empId]) {
          groupedAttendance[empId] = [];
        }
        
        groupedAttendance[empId].push({
          uid: log.uid,
          userId: log.id,
          employeeId: log.id.toString(),
          timestamp: log.timestamp,
          state: log.state,
          stateText: this.getStateText(log.state),
          type: this.getAttendanceType(log.state),
          date: log.timestamp.toISOString().split('T')[0],
          time: log.timestamp.toISOString().split('T')[1].substr(0, 8),
          rawData: {
            uid: log.uid,
            id: log.id,
            state: log.state,
            timestamp: log.timestamp
          }
        });
      });

      return {
        success: true,
        attendance: groupedAttendance,
        employeeIds,
        dateRange: { startDate, endDate },
        totalRecords: attendanceLogs.length,
        source: 'database'
      };

    } catch (error) {
      console.error(`❌ Database attendance fetch failed:`, error);
      return {
        success: false,
        error: error.message,
        attendance: {}
      };
    }
  }

  /**
   * Get attendance summary for a specific employee
   * @param {string} employeeId - Employee ID
   * @param {string} startDate - Start date (YYYY-MM-DD)
   * @param {string} endDate - End date (YYYY-MM-DD)
   * @returns {Object} Attendance summary with daily breakdown
   */
  static async getEmployeeAttendanceSummary(employeeId, startDate, endDate) {
    try {
      const result = await this.getEmployeeAttendance(employeeId, startDate, endDate);
      
      if (!result.success) {
        return result;
      }

      const dailySummary = {};
      
      result.attendance.forEach(log => {
        const date = log.date;
        if (!dailySummary[date]) {
          dailySummary[date] = {
            date,
            records: [],
            checkIn: null,
            checkOut: null,
            totalHours: 0,
            status: 'absent'
          };
        }
        
        dailySummary[date].records.push(log);
        
        // Track check-in/check-out
        if (log.state === 0) { // Check In
          if (!dailySummary[date].checkIn || log.timestamp < dailySummary[date].checkIn.timestamp) {
            dailySummary[date].checkIn = log;
          }
        } else if (log.state === 1) { // Check Out
          if (!dailySummary[date].checkOut || log.timestamp > dailySummary[date].checkOut.timestamp) {
            dailySummary[date].checkOut = log;
          }
        }
      });

      // Calculate working hours for each day
      Object.keys(dailySummary).forEach(date => {
        const day = dailySummary[date];
        if (day.checkIn && day.checkOut) {
          const hours = (new Date(day.checkOut.timestamp) - new Date(day.checkIn.timestamp)) / (1000 * 60 * 60);
          day.totalHours = Math.round(hours * 100) / 100; // Round to 2 decimal places
          day.status = 'present';
        } else if (day.checkIn) {
          day.status = 'partial'; // Has check-in but no check-out
        }
      });

      return {
        success: true,
        employeeId,
        dateRange: { startDate, endDate },
        dailySummary,
        totalDays: Object.keys(dailySummary).length,
        source: 'database'
      };

    } catch (error) {
      console.error(`❌ Attendance summary failed:`, error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Get text description for state code
   * @param {number} state - State code from database
   * @returns {string} Human readable state text
   */
  static getStateText(state) {
    const stateMap = {
      0: 'Check In',
      1: 'Check Out', 
      2: 'Break Out',
      3: 'Break In',
      4: 'OT In',
      5: 'OT Out'
    };
    return stateMap[state] || 'Unknown';
  }

  /**
   * Get attendance type for backward compatibility
   * @param {number} state - State code from database  
   * @returns {string} Attendance type
   */
  static getAttendanceType(state) {
    if (state === 0) return 'check-in';
    if (state === 1) return 'check-out';
    if (state === 2) return 'break-out';
    if (state === 3) return 'break-in';
    if (state === 4) return 'ot-in';
    if (state === 5) return 'ot-out';
    return 'unknown';
  }

  /**
   * Get attendance statistics for a date range
   * @param {string} startDate - Start date (YYYY-MM-DD)
   * @param {string} endDate - End date (YYYY-MM-DD)
   * @returns {Object} Attendance statistics
   */
  static async getAttendanceStats(startDate, endDate) {
    try {
      console.log(`📊 Getting attendance statistics (${startDate} to ${endDate})`);

      const attendanceCollection = mongoose.connection.db.collection('attendancelogs');
      
      const query = {
        timestamp: {
          $gte: new Date(startDate + 'T00:00:00.000Z'),
          $lte: new Date(endDate + 'T23:59:59.999Z')
        }
      };

      // Get total records count
      const totalRecords = await attendanceCollection.countDocuments(query);

      // Get unique employees count
      const uniqueEmployees = await attendanceCollection.distinct('id', query);

      // Get state distribution
      const stateDistribution = await attendanceCollection.aggregate([
        { $match: query },
        { $group: { _id: '$state', count: { $sum: 1 } } },
        { $sort: { _id: 1 } }
      ]).toArray();

      // Get daily attendance counts
      const dailyStats = await attendanceCollection.aggregate([
        { $match: query },
        {
          $group: {
            _id: { $dateToString: { format: "%Y-%m-%d", date: "$timestamp" } },
            count: { $sum: 1 },
            uniqueEmployees: { $addToSet: '$id' }
          }
        },
        { $sort: { _id: 1 } }
      ]).toArray();

      return {
        success: true,
        dateRange: { startDate, endDate },
        totalRecords,
        uniqueEmployeeCount: uniqueEmployees.length,
        uniqueEmployeeIds: uniqueEmployees,
        stateDistribution: stateDistribution.map(s => ({
          state: s._id,
          stateText: this.getStateText(s._id),
          count: s.count
        })),
        dailyStats: dailyStats.map(d => ({
          date: d._id,
          totalRecords: d.count,
          uniqueEmployees: d.uniqueEmployees.length
        })),
        source: 'database'
      };

    } catch (error) {
      console.error(`❌ Attendance stats failed:`, error);
      return {
        success: false,
        error: error.message
      };
    }
  }
}

module.exports = AttendanceDbService;