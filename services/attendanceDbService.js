const mongoose = require("mongoose");
const { localDateString, localTimeString, localDayRange } = require("../utils/timezone");

/**
 * Service for fetching attendance data from MongoDB instead of polling the ZK
 * machine directly.
 *
 * The attendancelogs collection holds documents in more than one shape, so
 * every read goes through normalizeLog():
 *   - legacy CSV import:   "User ID", "UID", "State", "Timestamp" (Timestamp is a STRING)
 *   - service-native:      id, uid, state, timestamp (Date)
 *   - AttendanceLog model: employeeId, machineUserId, type, timestamp (Date)
 *
 * Because the legacy Timestamp is a string, a Mongo range query on it compares
 * lexically and silently returns the wrong set. Date filtering is therefore
 * applied in JS after the timestamp has been parsed.
 */

// Maps the AttendanceLog "type" string back onto the numeric state codes the
// rest of this service and the UI are built around.
const TYPE_TO_STATE = {
  "check-in": 0,
  "check-out": 1,
  "break-out": 2,
  "break-in": 3,
  "ot-in": 4,
  "ot-out": 5,
};

class AttendanceDbService {
  /**
   * Reduce a stored document of any supported shape to {uid, id, state, timestamp}.
   * Returns null when the document carries no parseable timestamp.
   * @param {Object} doc - Raw document from the attendancelogs collection
   * @returns {Object|null} Normalized log
   */
  static normalizeLog(doc) {
    const rawTimestamp = doc.timestamp ?? doc.Timestamp;
    if (rawTimestamp === undefined || rawTimestamp === null) return null;

    const timestamp =
      rawTimestamp instanceof Date ? rawTimestamp : new Date(rawTimestamp);
    if (Number.isNaN(timestamp.getTime())) return null;

    const rawId = doc.id ?? doc["User ID"] ?? doc.employeeId;
    const id = typeof rawId === "number" ? rawId : parseInt(rawId, 10);

    let state = doc.state ?? doc.State;
    if (state === undefined && typeof doc.type === "string") {
      state = TYPE_TO_STATE[doc.type];
    }

    return {
      uid: doc.uid ?? doc.UID ?? doc.machineUserId,
      id: Number.isNaN(id) ? undefined : id,
      state,
      timestamp,
    };
  }

  /**
   * Build the employee-identity half of the query, covering every stored shape.
   * @param {Array<string|number>} employeeIds
   * @returns {Object} Mongo query fragment
   */
  static buildEmployeeQuery(employeeIds) {
    const ints = employeeIds
      .map((id) => parseInt(id, 10))
      .filter((id) => !Number.isNaN(id));
    const strings = employeeIds.map((id) => String(id));

    return {
      $or: [
        { id: { $in: ints } },
        { "User ID": { $in: ints } },
        { employeeId: { $in: strings } },
      ],
    };
  }

  /**
   * Fetch normalized, date-filtered, chronologically sorted logs.
   * @param {Object} options
   * @param {Array<string|number>|null} options.employeeIds - Omit for all employees
   * @param {string} options.startDate - YYYY-MM-DD
   * @param {string} options.endDate - YYYY-MM-DD
   * @returns {Promise<Array>} Normalized logs
   */
  static async fetchNormalizedLogs({ employeeIds = null, startDate, endDate }) {
    const collection = mongoose.connection.db.collection("attendancelogs");

    // The requested days are the office's calendar days, not UTC days of the
    // same name. Building the window in UTC shifts it by the zone offset, which
    // drops punches made before the offset each morning and pulls in the same
    // slice of the following day.
    const { start, end } = localDayRange(startDate, endDate);

    // Push the range into the query for documents that can answer it, and pull
    // back only the fields normalizeLog reads.
    const rangeQuery = {
      $or: [
        { timestamp: { $gte: start, $lte: end } },
        // Legacy CSV rows keep their time as a string, which sorts lexically -
        // a range query on it silently returns the wrong set, so they are
        // carried through and filtered below.
        { timestamp: { $exists: false } },
      ],
    };

    const query = employeeIds
      ? { $and: [this.buildEmployeeQuery(employeeIds), rangeQuery] }
      : rangeQuery;

    const docs = await collection
      .find(query)
      .project({
        timestamp: 1,
        Timestamp: 1,
        id: 1,
        "User ID": 1,
        employeeId: 1,
        uid: 1,
        UID: 1,
        machineUserId: 1,
        state: 1,
        State: 1,
        type: 1,
      })
      .toArray();

    return docs
      .map((doc) => this.normalizeLog(doc))
      .filter((log) => log && log.timestamp >= start && log.timestamp <= end)
      .sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * Shape a normalized log into the record format the API and UI consume.
   * @param {Object} log - Normalized log
   * @returns {Object} Presentation record
   */
  static toAttendanceRecord(log) {
    return {
      uid: log.uid,
      userId: log.id,
      employeeId: log.id === undefined ? "" : log.id.toString(),
      timestamp: log.timestamp,
      state: log.state,
      stateText: this.getStateText(log.state),
      type: this.getAttendanceType(log.state),
      // Shown to people, so both are the office's wall clock. toISOString()
      // here reported an 08:42 arrival as 03:42 and filed anything before
      // 05:00 local under the previous day.
      date: localDateString(log.timestamp),
      time: localTimeString(log.timestamp),
      rawData: {
        uid: log.uid,
        id: log.id,
        state: log.state,
        timestamp: log.timestamp,
      },
    };
  }

  /**
   * Get attendance logs for a specific employee.
   * @param {string} employeeId - Employee ID to fetch attendance for
   * @param {string} startDate - Start date (YYYY-MM-DD)
   * @param {string} endDate - End date (YYYY-MM-DD)
   * @param {string} companyId - Company ID for multi-tenancy (reserved)
   * @returns {Object} Attendance data with success flag
   */
  static async getEmployeeAttendance(
    employeeId,
    startDate,
    endDate,
    companyId = null
  ) {
    try {
      console.log(
        `Fetching attendance for employee ${employeeId} (${startDate} to ${endDate})`
      );

      const dbHost = mongoose.connection.host;
      const dbName = mongoose.connection.db.databaseName;

      const logs = await this.fetchNormalizedLogs({
        employeeIds: [employeeId],
        startDate,
        endDate,
      });

      console.log(
        `Found ${logs.length} attendance records in ${dbName} on ${dbHost}`
      );

      return {
        success: true,
        attendance: logs.map((log) => this.toAttendanceRecord(log)),
        employeeId,
        dateRange: { startDate, endDate },
        totalRecords: logs.length,
        source: "database",
        databaseInfo: {
          host: dbHost,
          database: dbName,
          isLocal: dbHost === "127.0.0.1" || dbHost === "localhost",
        },
      };
    } catch (error) {
      console.error(`Database attendance fetch failed:`, error);
      return {
        success: false,
        error: error.message,
        attendance: [],
        databaseHost: mongoose.connection.host,
        databaseName: mongoose.connection.db?.databaseName,
      };
    }
  }

  /**
   * Get attendance for multiple employees in a date range.
   * @param {Array} employeeIds - Array of employee IDs
   * @param {string} startDate - Start date (YYYY-MM-DD)
   * @param {string} endDate - End date (YYYY-MM-DD)
   * @param {string} companyId - Company ID for multi-tenancy (reserved)
   * @returns {Object} Attendance data grouped by employee
   */
  static async getMultipleEmployeeAttendance(
    employeeIds,
    startDate,
    endDate,
    companyId = null
  ) {
    try {
      console.log(
        `Fetching attendance for ${employeeIds.length} employees (${startDate} to ${endDate})`
      );

      const logs = await this.fetchNormalizedLogs({
        employeeIds,
        startDate,
        endDate,
      });

      console.log(`Found ${logs.length} attendance records`);

      const groupedAttendance = {};

      logs.forEach((log) => {
        const empId = log.id === undefined ? "" : log.id.toString();
        if (!groupedAttendance[empId]) {
          groupedAttendance[empId] = [];
        }
        groupedAttendance[empId].push(this.toAttendanceRecord(log));
      });

      return {
        success: true,
        attendance: groupedAttendance,
        employeeIds,
        dateRange: { startDate, endDate },
        totalRecords: logs.length,
        source: "database",
      };
    } catch (error) {
      console.error(`Database attendance fetch failed:`, error);
      return {
        success: false,
        error: error.message,
        attendance: {},
      };
    }
  }

  /**
   * Get attendance summary for a specific employee.
   * @param {string} employeeId - Employee ID
   * @param {string} startDate - Start date (YYYY-MM-DD)
   * @param {string} endDate - End date (YYYY-MM-DD)
   * @returns {Object} Attendance summary with daily breakdown
   */
  static async getEmployeeAttendanceSummary(employeeId, startDate, endDate) {
    try {
      const result = await this.getEmployeeAttendance(
        employeeId,
        startDate,
        endDate
      );

      if (!result.success) {
        return result;
      }

      const dailySummary = {};

      result.attendance.forEach((log) => {
        const date = log.date;
        if (!dailySummary[date]) {
          dailySummary[date] = {
            date,
            records: [],
            checkIn: null,
            checkOut: null,
            totalHours: 0,
            status: "absent",
          };
        }

        dailySummary[date].records.push(log);

        if (log.state === 0) {
          if (
            !dailySummary[date].checkIn ||
            log.timestamp < dailySummary[date].checkIn.timestamp
          ) {
            dailySummary[date].checkIn = log;
          }
        } else if (log.state === 1) {
          if (
            !dailySummary[date].checkOut ||
            log.timestamp > dailySummary[date].checkOut.timestamp
          ) {
            dailySummary[date].checkOut = log;
          }
        }
      });

      // The devices in this deployment report nearly every punch with state 1,
      // so a day can hold real punches yet never yield a state-0 check-in. When
      // that happens, derive the pair from punch order instead of leaving the
      // day marked absent. Days that do carry a state-0 record keep the
      // explicit state-based pairing above.
      Object.keys(dailySummary).forEach((date) => {
        const day = dailySummary[date];
        if (day.checkIn || day.records.length === 0) return;

        const ordered = [...day.records].sort(
          (a, b) => new Date(a.timestamp) - new Date(b.timestamp)
        );

        day.checkIn = ordered[0];
        day.checkOut = ordered.length > 1 ? ordered[ordered.length - 1] : null;
        day.derivedFromPunchOrder = true;
      });

      Object.keys(dailySummary).forEach((date) => {
        const day = dailySummary[date];
        if (day.checkIn && day.checkOut) {
          const hours =
            (new Date(day.checkOut.timestamp) -
              new Date(day.checkIn.timestamp)) /
            (1000 * 60 * 60);
          day.totalHours = Math.round(hours * 100) / 100;
          day.status = "present";
        } else if (day.checkIn) {
          day.status = "partial";
        }
      });

      return {
        success: true,
        employeeId,
        dateRange: { startDate, endDate },
        dailySummary,
        totalDays: Object.keys(dailySummary).length,
        source: "database",
      };
    } catch (error) {
      console.error(`Attendance summary failed:`, error);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Get text description for state code.
   * @param {number} state - State code from database
   * @returns {string} Human readable state text
   */
  static getStateText(state) {
    const stateMap = {
      0: "Check In",
      1: "Check Out",
      2: "Break Out",
      3: "Break In",
      4: "OT In",
      5: "OT Out",
    };
    return stateMap[state] || "Unknown";
  }

  /**
   * Get attendance type for backward compatibility.
   * @param {number} state - State code from database
   * @returns {string} Attendance type
   */
  static getAttendanceType(state) {
    if (state === 0) return "check-in";
    if (state === 1) return "check-out";
    if (state === 2) return "break-out";
    if (state === 3) return "break-in";
    if (state === 4) return "ot-in";
    if (state === 5) return "ot-out";
    return "unknown";
  }

  /**
   * Get attendance statistics for a date range.
   * Aggregation happens in JS rather than through the aggregation pipeline
   * because the legacy Timestamp field is a string, which $dateToString rejects.
   * @param {string} startDate - Start date (YYYY-MM-DD)
   * @param {string} endDate - End date (YYYY-MM-DD)
   * @returns {Object} Attendance statistics
   */
  static async getAttendanceStats(startDate, endDate) {
    try {
      console.log(`Getting attendance statistics (${startDate} to ${endDate})`);

      const logs = await this.fetchNormalizedLogs({ startDate, endDate });

      const uniqueEmployees = [
        ...new Set(logs.map((log) => log.id).filter((id) => id !== undefined)),
      ];

      const stateCounts = new Map();
      const dailyCounts = new Map();

      logs.forEach((log) => {
        stateCounts.set(log.state, (stateCounts.get(log.state) || 0) + 1);

        const date = localDateString(log.timestamp);
        if (!dailyCounts.has(date)) {
          dailyCounts.set(date, { count: 0, employees: new Set() });
        }
        const day = dailyCounts.get(date);
        day.count += 1;
        if (log.id !== undefined) day.employees.add(log.id);
      });

      const stateDistribution = [...stateCounts.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([state, count]) => ({
          state,
          stateText: this.getStateText(state),
          count,
        }));

      const dailyStats = [...dailyCounts.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([date, day]) => ({
          date,
          totalRecords: day.count,
          uniqueEmployees: day.employees.size,
        }));

      return {
        success: true,
        dateRange: { startDate, endDate },
        totalRecords: logs.length,
        uniqueEmployeeCount: uniqueEmployees.length,
        uniqueEmployeeIds: uniqueEmployees,
        stateDistribution,
        dailyStats,
        source: "database",
      };
    } catch (error) {
      console.error(`Attendance stats failed:`, error);
      return {
        success: false,
        error: error.message,
      };
    }
  }
}

module.exports = AttendanceDbService;
