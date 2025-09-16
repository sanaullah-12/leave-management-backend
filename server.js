const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");
require("dotenv").config();

// Debug environment variables
console.log("=== ENVIRONMENT VARIABLES ===");
console.log("NODE_ENV:", process.env.NODE_ENV);
console.log("MONGODB_URI:", process.env.MONGODB_URI ? "✅ Set" : "❌ Missing");
console.log("JWT_SECRET:", process.env.JWT_SECRET ? "✅ Set" : "❌ Missing");
console.log("ALLOWED_ORIGINS:", process.env.ALLOWED_ORIGINS ? "✅ Set" : "❌ Missing");
console.log("FRONTEND_URL:", process.env.FRONTEND_URL ? "✅ Set" : "❌ Missing");
console.log("📧 EMAIL CONFIGURATION:");
console.log("SMTP_HOST:", process.env.SMTP_HOST ? "✅ Set" : "❌ Missing");
console.log("SMTP_PORT:", process.env.SMTP_PORT ? "✅ Set" : "❌ Missing");
console.log("SMTP_EMAIL:", process.env.SMTP_EMAIL ? "✅ Set" : "❌ Missing");
console.log("SMTP_PASSWORD:", process.env.SMTP_PASSWORD ? "✅ Set" : "❌ Missing");
console.log("FROM_EMAIL:", process.env.FROM_EMAIL ? "✅ Set" : "❌ Missing");
console.log("FROM_NAME:", process.env.FROM_NAME ? "✅ Set" : "❌ Missing");
console.log("===============================");

const authRoutes = require("./routes/auth");
const leaveRoutes = require("./routes/leaves");
const userRoutes = require("./routes/users");
// const notificationRoutes = require("./routes/notifications"); // Removed for Socket.IO implementation

const app = express();

// CORS configuration (before other middlewares)
const allowedOrigins = ['http://localhost:3000']; // Always allow localhost for development

// Add origins from environment variable
if (process.env.ALLOWED_ORIGINS) {
  const envOrigins = process.env.ALLOWED_ORIGINS.split(',').map(origin => origin.trim());
  allowedOrigins.push(...envOrigins);
}

app.use(
  cors({
    origin: function (origin, callback) {
      // Allow requests with no origin (like mobile apps, Postman, etc.)
      if (!origin) return callback(null, true);
      
      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      } else {
        console.log(`CORS blocked origin: ${origin}`);
        console.log(`Allowed origins: ${allowedOrigins.join(', ')}`);
        return callback(new Error(`Not allowed by CORS. Origin: ${origin}`));
      }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
  })
);

// Security middlewares (after CORS)
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
  })
);
app.use(morgan("combined"));

// Rate limiting (relaxed for development stability)
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000, // Increased limit
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    // Skip rate limiting for health check and debug endpoints
    return req.url.includes('/health') || req.url.includes('/debug') || req.url.includes('/test');
  }
});
app.use(limiter);

// Body parser middleware
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// Serve static files for profile pictures
app.use("/uploads", express.static("uploads"));

// Database connection with retry logic
const connectDB = async (retryCount = 0) => {
  const maxRetries = 3;

  try {
    // Environment-based database configuration
    let connectionString;
    const environment = process.env.NODE_ENV || 'development';
    const useProductionDB = process.env.USE_PRODUCTION_DB === 'true';

    // Railway-specific: Ensure environment variables are loaded
    if (environment === 'production' && !process.env.MONGODB_URI) {
      console.log("⚠️  MONGODB_URI not found, waiting for Railway environment...");
      await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds
    }

    if (environment === 'production') {
      // Production: Use MongoDB Atlas
      connectionString = process.env.MONGODB_URI;
      if (!connectionString) {
        throw new Error('MONGODB_URI is required in production environment - check Railway variables');
      }
      console.log("🚀 PRODUCTION MODE: Using MongoDB Atlas");
    } else if (useProductionDB && process.env.MONGODB_URI) {
      // Development with production database access
      connectionString = process.env.MONGODB_URI;
      console.log("⚠️  DEVELOPMENT MODE: Using PRODUCTION database (USE_PRODUCTION_DB=true)");
      console.log("⚠️  WARNING: You are connecting to PRODUCTION data in development!");
    } else {
      // Development/Local: Force local database
      connectionString = "mongodb://127.0.0.1:27017/leave-management-dev";
      console.log("🔒 DEVELOPMENT MODE: Using local database only");
      console.log("💡 To use production data, set USE_PRODUCTION_DB=true in your .env file");
    }

    console.log("🔍 MONGODB CONNECTION DEBUG:");
    console.log("Retry attempt:", retryCount + 1, "/", maxRetries + 1);
    console.log("Environment:", environment);
    console.log("Database mode:",
      environment === 'production' ? 'Production (Atlas)' :
      useProductionDB ? 'Development using Production DB' : 'Development (Local)');
    console.log("Connection string:", connectionString.replace(/\/\/[^:]*:[^@]*@/, '//***:***@')); // Hide credentials
    console.log("Platform:", process.platform);
    console.log("Current time:", new Date().toISOString());
    console.log("Railway PORT:", process.env.PORT || 'Not set');

    console.log(
      environment === 'production' ? "📡 Attempting to connect to MongoDB Atlas..." :
      useProductionDB ? "📡 Attempting to connect to MongoDB Atlas (production data in dev)..." :
      "📡 Attempting to connect to local MongoDB..."
    );
    const startTime = Date.now();

    // Railway-optimized connection options
    await mongoose.connect(connectionString, {
      serverSelectionTimeoutMS: 20000, // 20 seconds (Railway timeout)
      socketTimeoutMS: 45000,          // 45 seconds
      connectTimeoutMS: 20000,         // 20 seconds
      bufferCommands: false,
      maxPoolSize: 5,                  // Reduced for Railway
      minPoolSize: 1,
      retryWrites: true,
      w: 'majority',
      maxIdleTimeMS: 30000,           // Close idle connections
      heartbeatFrequencyMS: 10000     // 10 second heartbeat
    });
    
    const connectionTime = Date.now() - startTime;
    console.log("✅ MongoDB connected successfully!");
    console.log(`Connection time: ${connectionTime}ms`);
    console.log("Database name:", mongoose.connection.db.databaseName);
    console.log("Connection host:", mongoose.connection.host);
    console.log("Connection ready state:", mongoose.connection.readyState);
    
  } catch (error) {
    console.error("❌ MongoDB connection failed:");
    console.error("Error name:", error.name);
    console.error("Error message:", error.message);
    console.error("Error code:", error.code);
    console.error("Error codeName:", error.codeName);

    if (error.reason) {
      console.error("Error reason:", error.reason);
    }

    // Railway-specific error handling
    if (error.message.includes('ENOTFOUND') || error.message.includes('getaddrinfo')) {
      console.error("🌐 DNS lookup failed - Railway network issue or MongoDB Atlas unreachable");
      console.error("💡 Check: MongoDB Atlas cluster is active and network access allows Railway IPs");
    } else if (error.message.includes('authentication failed') || error.message.includes('AuthenticationFailed')) {
      console.error("🔐 Authentication failed - check MongoDB Atlas credentials");
      console.error("💡 Verify: Database user credentials in MONGODB_URI are correct");
    } else if (error.message.includes('timeout') || error.message.includes('serverSelectionTimeout')) {
      console.error("⏰ Connection timeout - Railway to MongoDB Atlas timeout");
      console.error("💡 Check: MongoDB Atlas network access whitelist includes Railway IPs");
    } else if (error.message.includes('MongoServerSelectionError')) {
      console.error("🔍 Server selection failed - MongoDB Atlas connectivity issue");
      console.error("💡 Check: MongoDB Atlas cluster status and Railway network access");
    }

    // Retry logic for Railway
    if (retryCount < maxRetries) {
      const retryDelay = (retryCount + 1) * 3000; // 3s, 6s, 9s delays
      console.log(`🔄 Retrying connection in ${retryDelay/1000} seconds... (${retryCount + 1}/${maxRetries})`);

      await new Promise(resolve => setTimeout(resolve, retryDelay));
      return connectDB(retryCount + 1);
    }

    console.error("Full error object:", JSON.stringify(error, null, 2));
    console.log("💥 All retry attempts failed. MongoDB connection could not be established.");
    console.log("🔧 Railway Troubleshooting:");
    console.log("   1. Check Railway environment variables are set");
    console.log("   2. Verify MongoDB Atlas network access allows Railway");
    console.log("   3. Confirm MongoDB Atlas cluster is active");
    console.log("   4. Check Railway deployment logs for specific errors");
  }
};

// Connect to database
connectDB();

// Add database connection event listeners for stability
mongoose.connection.on('connected', () => {
  console.log('✅ Mongoose connected to MongoDB');
});

mongoose.connection.on('error', (err) => {
  console.error('❌ Mongoose connection error:', err);
});

mongoose.connection.on('disconnected', () => {
  console.log('⚠️  Mongoose disconnected from MongoDB');
  console.log('💡 If this happens frequently, check your MongoDB connection or restart the server');
});

// Handle process termination gracefully
process.on('SIGINT', async () => {
  console.log('📴 SIGINT received. Gracefully shutting down...');
  await mongoose.connection.close();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('📴 SIGTERM received. Gracefully shutting down...');
  await mongoose.connection.close();
  process.exit(0);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('💥 Uncaught Exception:', error);
  console.error('Stack trace:', error.stack);
  // Don't exit immediately - log and continue
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 Unhandled Rejection at:', promise, 'reason:', reason);
  // Don't exit immediately - log and continue
});


// Routes
app.use("/api/auth", authRoutes);
app.use("/api/leaves", leaveRoutes);
app.use("/api/users", userRoutes);
// app.use("/api/notifications", notificationRoutes); // Removed for Socket.IO implementation

// Health check route with database status
app.get("/api/health", async (req, res) => {
  try {
    // Check database connection
    const dbStatus = mongoose.connection.readyState;
    const dbStates = {
      0: 'disconnected',
      1: 'connected',
      2: 'connecting',
      3: 'disconnecting'
    };
    
    res.status(200).json({ 
      message: "Server is running",
      database: dbStates[dbStatus],
      environment: process.env.NODE_ENV,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ 
      message: "Health check failed", 
      error: error.message 
    });
  }
});

// Railway MongoDB connection test endpoint
app.get("/api/test-db", async (req, res) => {
  try {
    const dbStatus = mongoose.connection.readyState;
    const dbStates = { 0: 'disconnected', 1: 'connected', 2: 'connecting', 3: 'disconnecting' };

    let testResults = {
      connectionState: dbStates[dbStatus],
      message: dbStatus === 1 ? "Database connected successfully" : "Database not connected"
    };

    if (dbStatus === 1) {
      // Test database operations
      const collections = await mongoose.connection.db.listCollections().toArray();
      testResults.collections = collections.map(c => c.name);
      testResults.databaseName = mongoose.connection.db.databaseName;
      testResults.host = mongoose.connection.host;

      // Test a simple query if User model exists
      try {
        const User = require('./models/User');
        const userCount = await User.countDocuments();
        testResults.userCount = userCount;
        testResults.dataAccess = "✅ Success";
      } catch (error) {
        testResults.dataAccess = `❌ Failed: ${error.message}`;
      }
    }

    res.status(200).json({
      message: "🧪 Railway MongoDB Connection Test",
      timestamp: new Date().toISOString(),
      database: testResults
    });

  } catch (error) {
    res.status(500).json({
      message: "🧪 Railway MongoDB Connection Test",
      timestamp: new Date().toISOString(),
      database: {
        connectionState: "error",
        error: error.message
      }
    });
  }
});

// Debug endpoint for Railway troubleshooting
app.get("/api/debug", (req, res) => {
  res.status(200).json({
    message: "🔍 Railway Debug Information",
    timestamp: new Date().toISOString(),
    database: {
      connectionState: mongoose.connection.readyState,
      connectionStates: {
        0: 'disconnected',
        1: 'connected',
        2: 'connecting',
        3: 'disconnecting'
      },
      host: mongoose.connection.host || 'Not connected',
      databaseName: mongoose.connection.db?.databaseName || 'Not connected'
    },
    environment: {
      NODE_ENV: process.env.NODE_ENV,
      PORT: process.env.PORT,
      MONGODB_URI_exists: !!process.env.MONGODB_URI,
      MONGODB_URI_length: process.env.MONGODB_URI?.length || 0,
      MONGODB_URI_preview: process.env.MONGODB_URI ?
        process.env.MONGODB_URI.replace(/\/\/[^:]*:[^@]*@/, '//***:***@') :
        'Not set',
      JWT_SECRET_exists: !!process.env.JWT_SECRET,
      JWT_SECRET_length: process.env.JWT_SECRET?.length || 0,
      ALLOWED_ORIGINS_exists: !!process.env.ALLOWED_ORIGINS,
      FRONTEND_URL_exists: !!process.env.FRONTEND_URL,
      FRONTEND_URL_value: process.env.FRONTEND_URL || 'Not set'
    },
    email: {
      SMTP_HOST: process.env.SMTP_HOST || 'Not set',
      SMTP_PORT: process.env.SMTP_PORT || 'Not set',
      SMTP_EMAIL_exists: !!process.env.SMTP_EMAIL,
      SMTP_EMAIL_preview: process.env.SMTP_EMAIL ? process.env.SMTP_EMAIL.replace(/(.{2}).*(@.*)/, '$1***$2') : 'Not set',
      SMTP_PASSWORD_exists: !!process.env.SMTP_PASSWORD,
      FROM_EMAIL_exists: !!process.env.FROM_EMAIL,
      FROM_NAME_exists: !!process.env.FROM_NAME,
      config_valid: !!(process.env.SMTP_HOST && process.env.SMTP_PORT && process.env.SMTP_EMAIL && process.env.SMTP_PASSWORD && process.env.FROM_EMAIL)
    },
    database: {
      connection_state: mongoose.connection.readyState,
      connection_states: {
        0: 'disconnected',
        1: 'connected', 
        2: 'connecting',
        3: 'disconnecting'
      },
      current_state: mongoose.connection.readyState === 1 ? 'connected' : 
                     mongoose.connection.readyState === 2 ? 'connecting' :
                     mongoose.connection.readyState === 3 ? 'disconnecting' : 'disconnected',
      host: mongoose.connection.host || 'N/A',
      database_name: mongoose.connection.name || 'N/A'
    },
    system: {
      platform: process.platform,
      uptime: Math.floor(process.uptime()),
      memory_usage: process.memoryUsage(),
      timestamp: new Date().toISOString()
    }
  });
});

// Test database write endpoint
app.post("/api/debug/test-write", async (req, res) => {
  try {
    const db = mongoose.connection.db;
    const testCollection = db.collection('debug_test');
    
    const testDoc = {
      message: "Test write from Railway",
      timestamp: new Date().toISOString(),
      environment: process.env.NODE_ENV
    };
    
    const result = await testCollection.insertOne(testDoc);
    
    // Also check if we can read it back
    const readBack = await testCollection.findOne({ _id: result.insertedId });
    
    res.status(200).json({
      message: "✅ Database write test successful",
      database: mongoose.connection.db.databaseName,
      host: mongoose.connection.host,
      inserted_id: result.insertedId,
      read_back: !!readBack,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    res.status(500).json({
      message: "❌ Database write test failed",
      error: error.message,
      database: mongoose.connection.db.databaseName,
      host: mongoose.connection.host,
      timestamp: new Date().toISOString()
    });
  }
});

// Test email sending endpoint - SIMPLE VERSION
app.post("/api/debug/test-email", async (req, res) => {
  console.log('\n🧪 EMAIL TEST ENDPOINT CALLED');
  
  try {
    const targetEmail = req.body.email || process.env.SMTP_EMAIL || 'qazisanaullah612@gmail.com';
    console.log('🎯 Target email:', targetEmail);
    
    // Import fresh every time to avoid caching issues
    delete require.cache[require.resolve('./utils/email')];
    const { sendEmail } = require('./utils/email');
    
    const result = await sendEmail({
      email: targetEmail,
      subject: '🧪 URGENT TEST - Leave Management Email System',
      html: '<h1>🎉 SUCCESS!</h1><p>If you received this, your email system is working!</p>'
    });
    
    console.log('✅ Test email completed successfully');
    
    res.status(200).json({
      message: "✅ Test email completed - check your inbox!",
      target_email: targetEmail,
      result: result,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('❌ Test email failed:', error.message);
    
    res.status(500).json({
      message: "❌ Test email failed",
      error: error.message,
      environment_check: {
        smtp_email: process.env.SMTP_EMAIL || 'NOT SET',
        smtp_password_exists: !!process.env.SMTP_PASSWORD,
        node_env: process.env.NODE_ENV
      },
      timestamp: new Date().toISOString()
    });
  }
});

// Simple test endpoint
app.get("/api/test", (req, res) => {
  res.status(200).json({
    message: "🎉 Backend is deployed and working!",
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || "development",
    mongodb_connected: mongoose.connection.readyState === 1,
    uptime: process.uptime(),
    version: "1.0.0"
  });
});

// Root route for localhost:5000
app.get("/", (req, res) => {
  res.send(`
    <html>
      <head><title>Leave Management API</title></head>
      <body style="font-family: Arial; text-align: center; padding: 50px;">
        <h1>🎉 Leave Management API is Live!</h1>
        <p>Backend deployed successfully at ${new Date().toLocaleString()}</p>
        <p>Environment: ${process.env.NODE_ENV || "development"}</p>
        <p>MongoDB Status: ${mongoose.connection.readyState === 1 ? "✅ Connected" : "❌ Disconnected"}</p>
        <div style="margin: 30px 0;">
          <a href="/api/test" style="background: #3b82f6; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; margin: 5px;">JSON Test</a>
          <a href="/api/health" style="background: #10b981; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; margin: 5px;">Health Check</a>
        </div>
        <h3>Available API Endpoints:</h3>
        <ul style="text-align: left; max-width: 400px; margin: 0 auto;">
          <li><code>GET /api/health</code> - Health check</li>
          <li><code>GET /api/test</code> - Test endpoint</li>
          <li><code>POST /api/auth/register-company</code> - Register company</li>
          <li><code>POST /api/auth/login</code> - User login</li>
          <li><code>GET /api/leaves</code> - Get leaves (auth required)</li>
        </ul>
      </body>
    </html>
  `);
});

// Simple test endpoint that doesn't require authentication  
app.get("/test", (req, res) => {
  res.redirect('/');
});

// Request logging middleware for debugging
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    if (duration > 1000) { // Log slow requests
      console.log(`⏰ Slow request: ${req.method} ${req.path} - ${duration}ms`);
    }
  });
  next();
});

// Global error handler with better logging
app.use((err, req, res, next) => {
  console.error(`💥 Error in ${req.method} ${req.path}:`);
  console.error('Error message:', err.message);
  console.error('Error stack:', err.stack);
  
  res.status(err.status || 500).json({
    message: "Something went wrong!",
    error: process.env.NODE_ENV === "production" ? {} : err.message,
    path: req.path,
    method: req.method,
    timestamp: new Date().toISOString()
  });
});

// 404 handler for unknown routes
app.use("*", (req, res) => {
  res.status(404).json({ 
    message: "Route not found",
    path: req.originalUrl,
    hint: "Try /api/test for testing or / for the main page"
  });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
