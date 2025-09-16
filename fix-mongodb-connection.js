// MongoDB Connection Fix for Railway Production
const mongoose = require('mongoose');

// Force production environment
process.env.NODE_ENV = 'production';
require('dotenv').config({ path: '.env.production' });

console.log('🔧 MongoDB Connection Diagnostic & Fix');
console.log('=====================================');

// Test multiple connection string formats
const connectionTests = [
  {
    name: 'Original Connection String',
    uri: process.env.MONGODB_URI
  },
  {
    name: 'Without App Name',
    uri: process.env.MONGODB_URI?.replace(/&appName=Cluster0/, '')
  },
  {
    name: 'Basic Connection String',
    uri: 'mongodb+srv://qazisanaullah612_db_user:REMOVED@cluster0.3ouqpxd.mongodb.net/leave-management'
  },
  {
    name: 'With Minimal Options',
    uri: 'mongodb+srv://qazisanaullah612_db_user:REMOVED@cluster0.3ouqpxd.mongodb.net/leave-management?retryWrites=true&w=majority'
  }
];

async function testConnection(name, uri) {
  if (!uri) {
    console.log(`❌ ${name}: URI not available`);
    return false;
  }

  console.log(`\n🧪 Testing: ${name}`);
  console.log(`URI (masked): ${uri.replace(/\/\/[^:]*:[^@]*@/, '//***:***@')}`);

  try {
    // Close any existing connection
    if (mongoose.connection.readyState !== 0) {
      await mongoose.connection.close();
    }

    const startTime = Date.now();

    await mongoose.connect(uri, {
      serverSelectionTimeoutMS: 10000, // 10 seconds
      socketTimeoutMS: 45000,
      connectTimeoutMS: 10000,
      retryWrites: true,
      w: 'majority',
      maxPoolSize: 5,
      minPoolSize: 1,
      bufferCommands: false,
      useNewUrlParser: true,
      useUnifiedTopology: true
    });

    const connectionTime = Date.now() - startTime;
    console.log(`✅ ${name}: Connected successfully in ${connectionTime}ms`);
    console.log(`📊 Database: ${mongoose.connection.db.databaseName}`);
    console.log(`🖥️  Host: ${mongoose.connection.host}`);

    // Test a simple operation
    const collections = await mongoose.connection.db.listCollections().toArray();
    console.log(`📁 Collections: ${collections.map(c => c.name).join(', ')}`);

    await mongoose.connection.close();
    return true;

  } catch (error) {
    console.log(`❌ ${name}: Failed - ${error.message}`);

    if (error.name === 'MongoServerSelectionError') {
      console.log('   💡 Network or authentication issue');
    } else if (error.name === 'MongoParseError') {
      console.log('   💡 Connection string format issue');
    }

    return false;
  }
}

async function runConnectionTests() {
  console.log('📋 Environment Check:');
  console.log(`NODE_ENV: ${process.env.NODE_ENV}`);
  console.log(`MONGODB_URI exists: ${!!process.env.MONGODB_URI}`);

  let workingConnection = null;

  for (const test of connectionTests) {
    const success = await testConnection(test.name, test.uri);
    if (success && !workingConnection) {
      workingConnection = test;
    }
    await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second between tests
  }

  console.log('\n🎯 RESULTS:');
  if (workingConnection) {
    console.log(`✅ Working connection found: ${workingConnection.name}`);
    console.log('\n📝 UPDATE YOUR RAILWAY MONGODB_URI TO:');
    console.log(workingConnection.uri);
    console.log('\n🔧 Steps to fix:');
    console.log('1. Copy the URI above');
    console.log('2. Go to Railway → Project → Variables');
    console.log('3. Update MONGODB_URI with the working connection string');
    console.log('4. Wait for redeployment');
    console.log('5. Check /api/health endpoint');
  } else {
    console.log('❌ No working connection found');
    console.log('\n🔍 Possible issues:');
    console.log('1. MongoDB Atlas cluster is paused');
    console.log('2. Network Access IP whitelist issue');
    console.log('3. Database user credentials incorrect');
    console.log('4. Cluster unavailable');
  }
}

// Atlas troubleshooting
async function checkAtlasStatus() {
  console.log('\n🏥 MongoDB Atlas Health Check:');

  try {
    // Try to connect to Atlas admin
    const uri = 'mongodb+srv://qazisanaullah612_db_user:REMOVED@cluster0.3ouqpxd.mongodb.net/admin';
    await mongoose.connect(uri, {
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 5000
    });

    console.log('✅ Atlas cluster is reachable');
    const admin = mongoose.connection.db.admin();
    const status = await admin.serverStatus();
    console.log(`✅ Server version: ${status.version}`);

    await mongoose.connection.close();

  } catch (error) {
    console.log('❌ Atlas cluster issue:', error.message);

    if (error.message.includes('Authentication failed')) {
      console.log('💡 Check database user credentials');
    } else if (error.message.includes('connection attempt failed')) {
      console.log('💡 Check network access whitelist');
    }
  }
}

// Run all tests
async function main() {
  try {
    await checkAtlasStatus();
    await runConnectionTests();
  } catch (error) {
    console.error('💥 Test failed:', error.message);
  }

  process.exit(0);
}

main();