// MongoDB Atlas Production Connection Test
// Force production environment for this test
process.env.NODE_ENV = 'production';
require('dotenv').config({ path: '.env.production' });
const mongoose = require('mongoose');

console.log('=== MONGODB ATLAS CONNECTION TEST ===');
console.log('🕒 Test started at:', new Date().toISOString());

// Test the production MongoDB connection
async function testMongoDBConnection() {
  const connectionString = process.env.MONGODB_URI;

  console.log('\n📋 Connection Details:');
  console.log('Environment:', process.env.NODE_ENV);
  console.log('Connection string (masked):', connectionString ?
    connectionString.replace(/\/\/[^:]*:[^@]*@/, '//***:***@') : 'NOT SET');

  if (!connectionString) {
    console.error('❌ MONGODB_URI environment variable is not set!');
    process.exit(1);
  }

  try {
    console.log('\n📡 Attempting to connect to MongoDB Atlas...');
    const startTime = Date.now();

    // Enhanced connection options for production
    await mongoose.connect(connectionString, {
      // Connection timeouts
      serverSelectionTimeoutMS: 30000, // 30 seconds to select a server
      socketTimeoutMS: 45000,          // 45 seconds for socket operations
      connectTimeoutMS: 30000,         // 30 seconds to establish connection

      // Retry logic
      retryWrites: true,

      // Write concern
      w: 'majority',

      // Connection pool settings
      maxPoolSize: 10,        // Maximum 10 connections
      minPoolSize: 2,         // Minimum 2 connections
      maxIdleTimeMS: 300000,  // Close connections after 5 minutes

      // Buffer settings
      bufferCommands: false,

      // Heartbeat
      heartbeatFrequencyMS: 10000, // 10 seconds
    });

    const connectionTime = Date.now() - startTime;

    console.log('✅ MongoDB Atlas connected successfully!');
    console.log(`⏱️  Connection time: ${connectionTime}ms`);
    console.log('🏗️  Database name:', mongoose.connection.db.databaseName);
    console.log('🖥️  Host:', mongoose.connection.host);
    console.log('📊 Connection state:', mongoose.connection.readyState);

    // Test database operations
    console.log('\n🧪 Testing database operations...');

    // Test 1: List collections
    const collections = await mongoose.connection.db.listCollections().toArray();
    console.log(`📁 Found ${collections.length} collections:`,
      collections.map(c => c.name).join(', '));

    // Test 2: Test User model if it exists
    try {
      const User = require('./models/User');
      const userCount = await User.countDocuments();
      console.log(`👥 Total users: ${userCount}`);
    } catch (error) {
      console.log('ℹ️  User model test skipped:', error.message);
    }

    // Test 3: Test Company model if it exists
    try {
      const Company = require('./models/Company');
      const companyCount = await Company.countDocuments();
      console.log(`🏢 Total companies: ${companyCount}`);
    } catch (error) {
      console.log('ℹ️  Company model test skipped:', error.message);
    }

    // Test 4: Simple ping
    const adminDb = mongoose.connection.db.admin();
    const pingResult = await adminDb.ping();
    console.log('🏓 Database ping successful:', pingResult);

    console.log('\n✅ All database tests passed!');

  } catch (error) {
    console.error('\n❌ MongoDB connection failed:');
    console.error('Error name:', error.name);
    console.error('Error message:', error.message);

    // Specific error handling
    if (error.name === 'MongoServerSelectionError') {
      console.error('\n💡 Server Selection Error - Possible causes:');
      console.error('  1. MongoDB Atlas cluster is paused or sleeping');
      console.error('  2. IP address not whitelisted in Atlas');
      console.error('  3. Incorrect credentials');
      console.error('  4. Network connectivity issues');
    } else if (error.name === 'MongoParseError') {
      console.error('\n💡 Parse Error - Possible causes:');
      console.error('  1. Invalid connection string format');
      console.error('  2. Missing or incorrect parameters');
    } else if (error.name === 'MongoNetworkError') {
      console.error('\n💡 Network Error - Possible causes:');
      console.error('  1. Network connectivity issues');
      console.error('  2. Firewall blocking connection');
      console.error('  3. Atlas cluster unavailable');
    }

    process.exit(1);
  } finally {
    // Close connection
    if (mongoose.connection.readyState !== 0) {
      await mongoose.connection.close();
      console.log('\n🔒 Database connection closed');
    }
  }
}

// Atlas-specific troubleshooting
function showAtlasTroubleshooting() {
  console.log('\n🔧 MongoDB Atlas Troubleshooting Guide:');
  console.log('1. Check if cluster is active (not paused)');
  console.log('2. Verify IP whitelist includes 0.0.0.0/0 for Railway');
  console.log('3. Confirm username/password are correct');
  console.log('4. Ensure cluster has enough resources');
  console.log('5. Check Atlas service status');
  console.log('\n📖 More help: https://docs.atlas.mongodb.com/troubleshoot-connection/');
}

// Run the test
testMongoDBConnection()
  .then(() => {
    console.log('\n🎉 MongoDB Atlas connection test completed successfully!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n💥 Connection test failed:', error.message);
    showAtlasTroubleshooting();
    process.exit(1);
  });