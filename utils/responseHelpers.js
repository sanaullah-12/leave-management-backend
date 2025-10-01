// Utility function to create consistent attendance API responses
// This ensures all attendance-related responses have proper date fields
// to prevent "Invalid Date" errors in the frontend

function createAttendanceResponse(success, data = {}, message = '', error = null) {
  const now = new Date().toISOString();
  
  return {
    success,
    message,
    ...(error && { error }),
    // Always include these fields to prevent "Invalid Date" in frontend
    fetchedAt: data.fetchedAt || now,
    lastUpdated: data.lastUpdated || now,
    dataSource: data.dataSource || (success ? 'Real-Time Machine' : 'Real-Time Machine (Error)'),
    // Include original data
    ...data,
    // Ensure syncInfo is always present
    syncInfo: data.syncInfo || {
      lastSyncTime: success ? now : null,
      lastSyncTimeFormatted: success ? 'Just now' : 'Failed to sync',
      dataSource: 'Real-Time Machine',
      realTime: true,
      note: success ? 'Response generated successfully' : 'Response generated with error'
    }
  };
}

// Simple error response with date safety for authentication errors
function createAuthErrorResponse(message) {
  const now = new Date().toISOString();
  
  return {
    success: false,
    message,
    // Include basic date fields to prevent frontend "Invalid Date" errors
    fetchedAt: now,
    lastUpdated: now,
    dataSource: 'Authentication Error',
    syncInfo: {
      lastSyncTime: null,
      lastSyncTimeFormatted: 'Authentication required',
      dataSource: 'Authentication Error',
      realTime: false,
      note: 'User authentication failed'
    }
  };
}

module.exports = {
  createAttendanceResponse,
  createAuthErrorResponse
};