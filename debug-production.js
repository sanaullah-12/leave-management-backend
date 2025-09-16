// Production Debug Script
// Run this on your production server to diagnose login issues

require('dotenv').config();
const mongoose = require('mongoose');

console.log('=== PRODUCTION DEBUG INFORMATION ===');
console.log('📅 Date:', new Date().toISOString());
console.log('🌍 Environment:', process.env.NODE_ENV);
console.log('🖥️  Node Version:', process.version);

console.log('\n=== ENVIRONMENT VARIABLES ===');
console.log('NODE_ENV:', process.env.NODE_ENV);
console.log('PORT:', process.env.PORT);
console.log('MONGODB_URI:', process.env.MONGODB_URI ? '✅ Set (length: ' + process.env.MONGODB_URI.length + ')' : '❌ Missing');
console.log('JWT_SECRET:', process.env.JWT_SECRET ? '✅ Set (length: ' + process.env.JWT_SECRET.length + ')' : '❌ Missing');
console.log('JWT_EXPIRE:', process.env.JWT_EXPIRE);
console.log('FRONTEND_URL:', process.env.FRONTEND_URL);
console.log('ALLOWED_ORIGINS:', process.env.ALLOWED_ORIGINS);

console.log('\n=== EMAIL CONFIGURATION ===');
console.log('SMTP_HOST:', process.env.SMTP_HOST);
console.log('SMTP_PORT:', process.env.SMTP_PORT);
console.log('SMTP_EMAIL:', process.env.SMTP_EMAIL ? '✅ Set' : '❌ Missing');
console.log('FROM_EMAIL:', process.env.FROM_EMAIL);
console.log('FROM_NAME:', process.env.FROM_NAME);

// Test MongoDB connection
async function testDatabase() {
  console.log('\n=== DATABASE CONNECTION TEST ===');
  try {
    console.log('Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ MongoDB connected successfully');

    // Test if we can query users
    const User = require('./models/User');
    const userCount = await User.countDocuments();
    console.log(`📊 Total users in database: ${userCount}`);

    // Test if we can query companies
    const Company = require('./models/Company');
    const companyCount = await Company.countDocuments();
    console.log(`🏢 Total companies in database: ${companyCount}`);

    mongoose.connection.close();
    console.log('✅ Database test completed successfully');

  } catch (error) {
    console.error('❌ Database connection failed:', error.message);
  }
}

// Test JWT functionality
function testJWT() {
  console.log('\n=== JWT TEST ===');
  try {
    const jwt = require('jsonwebtoken');
    const testPayload = { id: 'test123', role: 'admin' };

    // Test token generation
    const token = jwt.sign(testPayload, process.env.JWT_SECRET, { expiresIn: '1h' });
    console.log('✅ JWT token generated successfully');
    console.log('🔑 Token length:', token.length);

    // Test token verification
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    console.log('✅ JWT token verified successfully');
    console.log('📦 Decoded payload:', decoded);

  } catch (error) {
    console.error('❌ JWT test failed:', error.message);
  }
}

// Test CORS origins
function testCORS() {
  console.log('\n=== CORS CONFIGURATION TEST ===');
  const allowedOrigins = ['http://localhost:3000'];

  if (process.env.ALLOWED_ORIGINS) {
    const envOrigins = process.env.ALLOWED_ORIGINS.split(',').map(origin => origin.trim());
    allowedOrigins.push(...envOrigins);
  }

  console.log('📡 Allowed CORS origins:');
  allowedOrigins.forEach((origin, index) => {
    console.log(`  ${index + 1}. ${origin}`);
  });

  // Test if frontend URL is in allowed origins
  const frontendUrl = process.env.FRONTEND_URL;
  if (frontendUrl && allowedOrigins.includes(frontendUrl)) {
    console.log('✅ Frontend URL is in allowed CORS origins');
  } else {
    console.log('❌ Frontend URL is NOT in allowed CORS origins');
    console.log('   Frontend URL:', frontendUrl);
  }
}

// Run all tests
async function runDiagnostics() {
  console.log('🔍 Starting production diagnostics...\n');

  testJWT();
  testCORS();
  await testDatabase();

  console.log('\n=== DIAGNOSTICS COMPLETE ===');
  console.log('📝 Check the output above for any ❌ errors');
  console.log('💡 Common issues:');
  console.log('   1. JWT_SECRET not set or still placeholder');
  console.log('   2. ALLOWED_ORIGINS missing or incorrect');
  console.log('   3. MongoDB connection string invalid');
  console.log('   4. Environment variables not loaded correctly');
  process.exit(0);
}

runDiagnostics().catch(console.error);