const express = require('express');
const router = express.Router();
const BiometricService = require('../services/BiometricService');
const { authenticateToken, authorizeRoles } = require('../middleware/auth');

// Store active connections
const activeConnections = new Map();

// Test connection to biometric device
router.post('/test-connection', authenticateToken, authorizeRoles('admin'), async (req, res) => {
  try {
    const { ip, port = 4370 } = req.body;

    if (!ip) {
      return res.status(400).json({
        success: false,
        message: 'IP address is required'
      });
    }

    console.log(`🧪 Testing connection to biometric device at ${ip}:${port}`);

    const biometricService = new BiometricService(ip, port);
    const result = await biometricService.testConnection();

    res.json(result);

  } catch (error) {
    console.error('❌ Connection test failed:', error.message);
    res.status(500).json({
      success: false,
      message: error.message,
      error: 'Connection test failed'
    });
  }
});

// Connect to biometric device
router.post('/connect', authenticateToken, authorizeRoles('admin'), async (req, res) => {
  try {
    const { ip, port = 4370 } = req.body;

    if (!ip) {
      return res.status(400).json({
        success: false,
        message: 'IP address is required'
      });
    }

    console.log(`🔌 Connecting to biometric device at ${ip}:${port}`);

    const biometricService = new BiometricService(ip, port);
    const result = await biometricService.connect();

    // Store connection
    activeConnections.set(ip, {
      service: biometricService,
      connectedAt: new Date(),
      lastUsed: new Date()
    });

    res.json({
      success: true,
      message: `Successfully connected to biometric device at ${ip}:${port}`,
      data: result
    });

  } catch (error) {
    console.error('❌ Connection failed:', error.message);
    res.status(500).json({
      success: false,
      message: error.message,
      error: 'Failed to connect to biometric device'
    });
  }
});

// Disconnect from biometric device
router.post('/disconnect/:ip', authenticateToken, authorizeRoles('admin'), async (req, res) => {
  try {
    const { ip } = req.params;

    const connection = activeConnections.get(ip);
    if (!connection) {
      return res.status(404).json({
        success: false,
        message: `No active connection found for device ${ip}`
      });
    }

    console.log(`🔌 Disconnecting from biometric device at ${ip}`);

    await connection.service.disconnect();
    activeConnections.delete(ip);

    res.json({
      success: true,
      message: `Successfully disconnected from biometric device at ${ip}`
    });

  } catch (error) {
    console.error('❌ Disconnect failed:', error.message);
    res.status(500).json({
      success: false,
      message: error.message,
      error: 'Failed to disconnect from biometric device'
    });
  }
});

// Get employees from biometric device
router.get('/employees/:ip', authenticateToken, authorizeRoles('admin'), async (req, res) => {
  try {
    const { ip } = req.params;

    console.log(`👥 Fetching employees from biometric device at ${ip}`);

    // Check for existing connection
    let connection = activeConnections.get(ip);
    let biometricService;

    if (connection) {
      biometricService = connection.service;
      connection.lastUsed = new Date();
      console.log(`✅ Using existing connection to ${ip}`);
    } else {
      console.log(`🔌 Creating new connection to ${ip}`);
      biometricService = new BiometricService(ip, 4370);
      await biometricService.connect();

      // Store connection for future use
      activeConnections.set(ip, {
        service: biometricService,
        connectedAt: new Date(),
        lastUsed: new Date()
      });
    }

    // Get employees
    const employees = await biometricService.getEmployees();

    res.json({
      success: true,
      employees: employees,
      count: employees.length,
      machineIp: ip,
      fetchedAt: new Date().toISOString(),
      source: 'biometric_device'
    });

  } catch (error) {
    console.error('❌ Failed to get employees:', error.message);
    res.status(500).json({
      success: false,
      message: error.message,
      error: 'Failed to retrieve employees from biometric device'
    });
  }
});

// Get attendance logs from biometric device
router.get('/attendance/:ip', authenticateToken, authorizeRoles('admin'), async (req, res) => {
  try {
    const { ip } = req.params;
    const { startDate } = req.query;

    console.log(`📊 Fetching attendance logs from biometric device at ${ip}`);

    // Check for existing connection
    let connection = activeConnections.get(ip);
    let biometricService;

    if (connection) {
      biometricService = connection.service;
      connection.lastUsed = new Date();
      console.log(`✅ Using existing connection to ${ip}`);
    } else {
      console.log(`🔌 Creating new connection to ${ip}`);
      biometricService = new BiometricService(ip, 4370);
      await biometricService.connect();

      // Store connection
      activeConnections.set(ip, {
        service: biometricService,
        connectedAt: new Date(),
        lastUsed: new Date()
      });
    }

    // Get attendance logs
    const attendanceLogs = await biometricService.getAttendanceLogs(startDate);

    res.json({
      success: true,
      attendance: attendanceLogs,
      count: attendanceLogs.length,
      machineIp: ip,
      startDate: startDate || null,
      fetchedAt: new Date().toISOString(),
      source: 'biometric_device'
    });

  } catch (error) {
    console.error('❌ Failed to get attendance logs:', error.message);
    res.status(500).json({
      success: false,
      message: error.message,
      error: 'Failed to retrieve attendance logs from biometric device'
    });
  }
});

// Get active connections status
router.get('/connections', authenticateToken, authorizeRoles('admin'), (req, res) => {
  try {
    const connections = Array.from(activeConnections.entries()).map(([ip, connection]) => ({
      ip: ip,
      connectedAt: connection.connectedAt,
      lastUsed: connection.lastUsed,
      status: connection.service.isConnected ? 'connected' : 'disconnected'
    }));

    res.json({
      success: true,
      connections: connections,
      count: connections.length
    });

  } catch (error) {
    console.error('❌ Failed to get connections status:', error.message);
    res.status(500).json({
      success: false,
      message: error.message,
      error: 'Failed to get connections status'
    });
  }
});

// Clean up old connections (runs every 30 minutes)
setInterval(() => {
  const now = new Date();
  const thirtyMinutesAgo = new Date(now.getTime() - 30 * 60 * 1000);

  for (const [ip, connection] of activeConnections.entries()) {
    if (connection.lastUsed < thirtyMinutesAgo) {
      console.log(`🧹 Cleaning up inactive connection to ${ip}`);
      connection.service.disconnect().catch(err =>
        console.warn(`⚠️ Error disconnecting from ${ip}:`, err.message)
      );
      activeConnections.delete(ip);
    }
  }
}, 30 * 60 * 1000); // 30 minutes

module.exports = router;