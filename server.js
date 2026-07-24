const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");
// Load environment variables
const path = require("path");
const fs = require("fs");
if (process.env.NODE_ENV === "production") {
  require("dotenv").config({ path: path.join(__dirname, ".env.production") });
} else {
  require("dotenv").config();
}

// Debug environment variables
console.log("=== ENVIRONMENT VARIABLES ===");
console.log("NODE_ENV:", process.env.NODE_ENV);
console.log("MONGODB_URI:", process.env.MONGODB_URI ? "✅ Set" : "❌ Missing");
console.log("JWT_SECRET:", process.env.JWT_SECRET ? "✅ Set" : "❌ Missing");
console.log(
  "ALLOWED_ORIGINS:",
  process.env.ALLOWED_ORIGINS ? "✅ Set" : "❌ Missing"
);
console.log(
  "FRONTEND_URL:",
  process.env.FRONTEND_URL ? "✅ Set" : "❌ Missing"
);
console.log("📧 EMAIL CONFIGURATION:");
console.log("SMTP_HOST:", process.env.SMTP_HOST ? "✅ Set" : "❌ Missing");
console.log("SMTP_PORT:", process.env.SMTP_PORT ? "✅ Set" : "❌ Missing");
console.log("SMTP_EMAIL:", process.env.SMTP_EMAIL ? "✅ Set" : "❌ Missing");
console.log(
  "SMTP_PASSWORD:",
  process.env.SMTP_PASSWORD ? "✅ Set" : "❌ Missing"
);
console.log("FROM_EMAIL:", process.env.FROM_EMAIL ? "✅ Set" : "❌ Missing");
console.log("FROM_NAME:", process.env.FROM_NAME ? "✅ Set" : "❌ Missing");
console.log("===============================");

const authRoutes = require("./routes/auth");
const leaveRoutes = require("./routes/leaves");
const userRoutes = require("./routes/users");
const debugRoutes = require("./routes/debug");
const attendanceRoutes = require("./routes/attendance");
const biometricRoutes = require("./routes/biometric");
const employeesFixRoutes = require("./routes/employees-fix");
const employeePerformanceRoutes = require("./routes/employeePerformance");
const machinePerformanceRoutes = require("./routes/machinePerformance");
// const notificationRoutes = require("./routes/notifications"); // Removed for Socket.IO implementation

const app = express();

// CORS configuration (before other middlewares)
const allowedOrigins = ["http://localhost:3000"]; // Always allow localhost for development

// Add origins from environment variable
if (process.env.ALLOWED_ORIGINS) {
  const envOrigins = process.env.ALLOWED_ORIGINS.split(",").map((origin) =>
    origin.trim()
  );
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
        console.log(`Allowed origins: ${allowedOrigins.join(", ")}`);
        return callback(new Error(`Not allowed by CORS. Origin: ${origin}`));
      }
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
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
    return (
      req.url.includes("/health") ||
      req.url.includes("/debug") ||
      req.url.includes("/test")
    );
  },
});
app.use(limiter);

// Body parser middleware
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// Serve static files for profile pictures with better error handling
const uploadsPath = path.join(__dirname, "uploads");
console.log("📁 Static files directory:", uploadsPath);

// Ensure uploads directory exists
if (!fs.existsSync(uploadsPath)) {
  fs.mkdirSync(uploadsPath, { recursive: true });
  console.log("📁 Created uploads directory");
}

app.use(
  "/uploads",
  express.static(uploadsPath, {
    fallthrough: false,
    index: false,
    setHeaders: (res, path) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    },
  })
);

// Handle static file 404s
app.use("/uploads/*", (req, res) => {
  console.log("❌ Static file not found:", req.path);
  res.status(404).json({
    message: "File not found",
    path: req.path,
    hint: "File may have been lost due to Railway ephemeral storage",
  });
});

// Database connection with retry logic
const connectDB = async (retryCount = 0) => {
  const maxRetries = 3;

  try {
    // FORCE LOCAL DATABASE CONNECTION - ALWAYS USE LOCAL IN DEVELOPMENT
    let connectionString;

    // Check if this is actually production deployment (Railway/Vercel/etc)
    const isActualProduction =
      process.env.RAILWAY_ENVIRONMENT === "production" ||
      process.env.VERCEL_ENV === "production" ||
      (process.env.NODE_ENV === "production" &&
        process.env.PORT &&
        parseInt(process.env.PORT) !== 5000);

    // Explicit opt-in to the real Atlas data while running locally.
    // Required because the real users/employees live in Atlas, not locally.
    const useProductionDB = process.env.USE_PRODUCTION_DB === "true";

    if (isActualProduction || useProductionDB) {
      connectionString = process.env.MONGODB_URI;
      if (!connectionString) {
        console.error(
          "❌ CRITICAL: MONGODB_URI is not set in the production environment."
        );
        process.exit(1);
      }
      if (isActualProduction) {
        console.log("🚀 PRODUCTION DEPLOYMENT: Using MongoDB Atlas");
      } else {
        console.log(
          "⚠️  USE_PRODUCTION_DB=true — LOCAL SERVER IS USING THE LIVE ATLAS DATABASE."
        );
        console.log(
          "⚠️  Reads AND WRITES affect real production records. Set it to false when done."
        );
      }
    } else {
      // FORCE LOCAL DATABASE - Ignore the production MONGODB_URI.
      // Port 27018 is this app's dedicated mongo container, so we never collide
      // with another project's mongo on the default 27017 (which requires auth).
      connectionString =
        process.env.LOCAL_MONGODB_URI ||
        "mongodb://127.0.0.1:27018/leave-management-dev";
      console.log("🔒 DEVELOPMENT MODE: FORCING LOCAL DATABASE CONNECTION");
      console.log("📍 Connecting to:", connectionString);
      console.log("🚫 Ignoring MONGODB_URI environment variable");
      console.log("🚫 Ignoring NODE_ENV setting");
      console.log("💡 Set USE_PRODUCTION_DB=true to use the live Atlas data.");
    }

    console.log("🔍 MONGODB CONNECTION DEBUG:");
    console.log("Retry attempt:", retryCount + 1, "/", maxRetries + 1);
    console.log("NODE_ENV:", process.env.NODE_ENV);
    console.log("PORT:", process.env.PORT);
    console.log("RAILWAY_ENVIRONMENT:", process.env.RAILWAY_ENVIRONMENT);
    console.log("VERCEL_ENV:", process.env.VERCEL_ENV);
    console.log("Is Actual Production:", isActualProduction);
    console.log("Connection string:", connectionString);
    console.log("Platform:", process.platform);
    console.log("Current time:", new Date().toISOString());

    console.log("📡 Attempting to connect to LOCAL MongoDB...");
    const startTime = Date.now();

    // Local MongoDB connection options (simplified)
    await mongoose.connect(connectionString, {
      serverSelectionTimeoutMS: 5000, // 5 seconds for local
      socketTimeoutMS: 10000, // 10 seconds for local
      connectTimeoutMS: 5000, // 5 seconds for local
      bufferCommands: false,
      maxPoolSize: 10, // More connections for local
    });

    const connectionTime = Date.now() - startTime;
    console.log("✅ LOCAL MongoDB connected successfully!");
    console.log(`Connection time: ${connectionTime}ms`);
    console.log("Database name:", mongoose.connection.db.databaseName);
    console.log("Connection host:", mongoose.connection.host);
    console.log("Connection ready state:", mongoose.connection.readyState);

    // Verify it's actually local
    if (
      mongoose.connection.host === "127.0.0.1" ||
      mongoose.connection.host === "localhost"
    ) {
      console.log("✅ CONFIRMED: Connected to LOCAL database");
    } else {
      console.log(
        "⚠️  WARNING: Connected to REMOTE database:",
        mongoose.connection.host
      );
    }
  } catch (error) {
    console.error("❌ LOCAL MongoDB connection failed:");
    console.error("Error name:", error.name);
    console.error("Error message:", error.message);
    console.error("Error code:", error.code);

    // Local database specific error handling
    if (
      error.message.includes("ECONNREFUSED") ||
      error.message.includes("connect ECONNREFUSED")
    ) {
      console.error(
        "🔌 Local MongoDB connection refused - is MongoDB running?"
      );
      console.error("💡 Start MongoDB with one of these commands:");
      console.error("   • mongod");
      console.error(
        "   • brew services start mongodb/brew/mongodb-community (Mac)"
      );
      console.error("   • sudo systemctl start mongod (Linux)");
      console.error("   • net start MongoDB (Windows)");
    } else if (
      error.message.includes("ENOTFOUND") ||
      error.message.includes("getaddrinfo")
    ) {
      console.error("🌐 DNS lookup failed for localhost - network issue");
      console.error(
        "💡 Check: MongoDB is installed and running on localhost:27017"
      );
    } else if (error.message.includes("timeout")) {
      console.error("⏰ Connection timeout to local MongoDB");
      console.error("💡 Check: MongoDB service is running and responsive");
    }

    // Retry logic for local connection
    if (retryCount < maxRetries) {
      const retryDelay = (retryCount + 1) * 2000; // 2s, 4s, 6s delays
      console.log(
        `🔄 Retrying LOCAL connection in ${retryDelay / 1000} seconds... (${
          retryCount + 1
        }/${maxRetries})`
      );

      await new Promise((resolve) => setTimeout(resolve, retryDelay));
      return connectDB(retryCount + 1);
    }

    console.error("Full error object:", JSON.stringify(error, null, 2));
    console.log(
      "💥 All retry attempts failed. LOCAL MongoDB connection could not be established."
    );
    console.log("🔧 Local MongoDB Troubleshooting:");
    console.log("   1. Install MongoDB Community Edition");
    console.log("   2. Start MongoDB service:");
    console.log("      • Windows: net start MongoDB");
    console.log(
      "      • Mac: brew services start mongodb/brew/mongodb-community"
    );
    console.log("      • Linux: sudo systemctl start mongod");
    console.log("   3. Check if MongoDB is running: netstat -an | grep :27017");
    console.log("   4. Verify MongoDB installation: mongod --version");
    console.log("   5. Check MongoDB logs for errors");
  }
};

// Connect to database
connectDB();

// Add database connection event listeners for stability
mongoose.connection.on("connected", () => {
  console.log("✅ Mongoose connected to MongoDB");
});

mongoose.connection.on("error", (err) => {
  console.error("❌ Mongoose connection error:", err);
});

mongoose.connection.on("disconnected", () => {
  console.log("⚠️  Mongoose disconnected from MongoDB");
  console.log(
    "💡 If this happens frequently, check your MongoDB connection or restart the server"
  );
});

// Handle process termination gracefully
process.on("SIGINT", async () => {
  console.log("📴 SIGINT received. Gracefully shutting down...");
  await mongoose.connection.close();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("📴 SIGTERM received. Gracefully shutting down...");
  await mongoose.connection.close();
  process.exit(0);
});

// Handle uncaught exceptions
process.on("uncaughtException", (error) => {
  console.error("💥 Uncaught Exception:", error);
  console.error("Stack trace:", error.stack);
  // Don't exit immediately - log and continue
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("💥 Unhandled Rejection at:", promise, "reason:", reason);
  // Don't exit immediately - log and continue
});

// Global request logging for debugging invite issues
app.use("/api/auth/invite-employee", (req, res, next) => {
  console.log("🔴 === INTERCEPTED INVITE REQUEST ===");
  console.log("🔴 Timestamp:", new Date().toISOString());
  console.log("🔴 Method:", req.method);
  console.log("🔴 URL:", req.url);
  console.log("🔴 Body:", JSON.stringify(req.body));
  console.log("🔴 Content-Type:", req.headers["content-type"]);
  console.log(
    "🔴 Authorization:",
    req.headers.authorization ? "Present" : "Missing"
  );
  console.log("🔴 === FORWARDING TO ROUTE ===");
  next();
});

// Routes
app.use("/api/auth", authRoutes);
app.use("/api/leaves", leaveRoutes);
app.use("/api/users", userRoutes);
app.use("/api/debug", debugRoutes);
app.use("/api/attendance", attendanceRoutes);
app.use("/api/biometric", biometricRoutes);
app.use("/api/employees", employeesFixRoutes);
app.use("/api/employee-performance", employeePerformanceRoutes);
app.use("/api/machine-performance", machinePerformanceRoutes);
app.use("/api/simple-performance", require("./routes/simplePerformance"));
app.use(
  "/api/real-machine-performance",
  require("./routes/realMachinePerformance")
);
// app.use("/api/notifications", notificationRoutes); // Removed for Socket.IO implementation

// Health check route with database status
app.get("/api/health", async (req, res) => {
  try {
    // Check database connection
    const dbStatus = mongoose.connection.readyState;
    const dbStates = {
      0: "disconnected",
      1: "connected",
      2: "connecting",
      3: "disconnecting",
    };

    res.status(200).json({
      message: "Server is running",
      database: dbStates[dbStatus],
      environment: process.env.NODE_ENV,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({
      message: "Health check failed",
      error: error.message,
    });
  }
});

// Railway MongoDB connection test endpoint
app.get("/api/test-db", async (req, res) => {
  try {
    const dbStatus = mongoose.connection.readyState;
    const dbStates = {
      0: "disconnected",
      1: "connected",
      2: "connecting",
      3: "disconnecting",
    };

    let testResults = {
      connectionState: dbStates[dbStatus],
      message:
        dbStatus === 1
          ? "Database connected successfully"
          : "Database not connected",
    };

    if (dbStatus === 1) {
      // Test database operations
      const collections = await mongoose.connection.db
        .listCollections()
        .toArray();
      testResults.collections = collections.map((c) => c.name);
      testResults.databaseName = mongoose.connection.db.databaseName;
      testResults.host = mongoose.connection.host;

      // Test a simple query if User model exists
      try {
        const User = require("./models/User");
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
      database: testResults,
    });
  } catch (error) {
    res.status(500).json({
      message: "🧪 Railway MongoDB Connection Test",
      timestamp: new Date().toISOString(),
      database: {
        connectionState: "error",
        error: error.message,
      },
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
        0: "disconnected",
        1: "connected",
        2: "connecting",
        3: "disconnecting",
      },
      host: mongoose.connection.host || "Not connected",
      databaseName: mongoose.connection.db?.databaseName || "Not connected",
    },
    environment: {
      NODE_ENV: process.env.NODE_ENV,
      PORT: process.env.PORT,
      MONGODB_URI_exists: !!process.env.MONGODB_URI,
      MONGODB_URI_length: process.env.MONGODB_URI?.length || 0,
      MONGODB_URI_preview: process.env.MONGODB_URI
        ? process.env.MONGODB_URI.replace(/\/\/[^:]*:[^@]*@/, "//***:***@")
        : "Not set",
      JWT_SECRET_exists: !!process.env.JWT_SECRET,
      JWT_SECRET_length: process.env.JWT_SECRET?.length || 0,
      ALLOWED_ORIGINS_exists: !!process.env.ALLOWED_ORIGINS,
      FRONTEND_URL_exists: !!process.env.FRONTEND_URL,
      FRONTEND_URL_value: process.env.FRONTEND_URL || "Not set",
    },
    email: {
      SMTP_HOST: process.env.SMTP_HOST || "Not set",
      SMTP_PORT: process.env.SMTP_PORT || "Not set",
      SMTP_EMAIL_exists: !!process.env.SMTP_EMAIL,
      SMTP_EMAIL_preview: process.env.SMTP_EMAIL
        ? process.env.SMTP_EMAIL.replace(/(.{2}).*(@.*)/, "$1***$2")
        : "Not set",
      SMTP_PASSWORD_exists: !!process.env.SMTP_PASSWORD,
      FROM_EMAIL_exists: !!process.env.FROM_EMAIL,
      FROM_NAME_exists: !!process.env.FROM_NAME,
      config_valid: !!(
        process.env.SMTP_HOST &&
        process.env.SMTP_PORT &&
        process.env.SMTP_EMAIL &&
        process.env.SMTP_PASSWORD &&
        process.env.FROM_EMAIL
      ),
    },
    database: {
      connection_state: mongoose.connection.readyState,
      connection_states: {
        0: "disconnected",
        1: "connected",
        2: "connecting",
        3: "disconnecting",
      },
      current_state:
        mongoose.connection.readyState === 1
          ? "connected"
          : mongoose.connection.readyState === 2
          ? "connecting"
          : mongoose.connection.readyState === 3
          ? "disconnecting"
          : "disconnected",
      host: mongoose.connection.host || "N/A",
      database_name: mongoose.connection.name || "N/A",
    },
    system: {
      platform: process.platform,
      uptime: Math.floor(process.uptime()),
      memory_usage: process.memoryUsage(),
      timestamp: new Date().toISOString(),
    },
  });
});

// Test database write endpoint
app.post("/api/debug/test-write", async (req, res) => {
  try {
    const db = mongoose.connection.db;
    const testCollection = db.collection("debug_test");

    const testDoc = {
      message: "Test write from Railway",
      timestamp: new Date().toISOString(),
      environment: process.env.NODE_ENV,
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
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({
      message: "❌ Database write test failed",
      error: error.message,
      database: mongoose.connection.db.databaseName,
      host: mongoose.connection.host,
      timestamp: new Date().toISOString(),
    });
  }
});

// Force SendGrid test endpoint
app.post("/api/debug/test-sendgrid", async (req, res) => {
  console.log("\n🧪 FORCE SENDGRID TEST ENDPOINT CALLED");

  try {
    const targetEmail =
      req.body.email || process.env.SMTP_EMAIL || "qazisanaullah612@gmail.com";
    console.log("🎯 Target email:", targetEmail);

    // Force use SendGrid directly
    const sendGridKey =
      process.env.SendGrid_Key || process.env.SENDGRID_API_KEY;

    if (!sendGridKey) {
      return res.status(400).json({
        message: "❌ No SendGrid API key found",
        variables_checked: ["SendGrid_Key", "SENDGRID_API_KEY"],
        sendgrid_key_railway: !!process.env.SendGrid_Key,
        sendgrid_key_standard: !!process.env.SENDGRID_API_KEY,
      });
    }

    const sgMail = require("@sendgrid/mail");
    sgMail.setApiKey(sendGridKey);

    const mailOptions = {
      from: {
        email: process.env.FROM_EMAIL,
        name: process.env.FROM_NAME || "Leave Management System",
      },
      to: targetEmail,
      subject: "🧪 DIRECT SENDGRID TEST - Railway",
      html:
        "<h1>🎉 SUCCESS!</h1><p>This email was sent directly via SendGrid API!</p><p>Time: " +
        new Date().toISOString() +
        "</p>",
      text:
        "SUCCESS! This email was sent directly via SendGrid API! Time: " +
        new Date().toISOString(),
    };

    console.log("📤 Sending directly via SendGrid...");
    console.log("📤 Using API Key:", sendGridKey.substring(0, 10) + "...");
    console.log("📤 From:", mailOptions.from);
    console.log("📤 To:", targetEmail);

    const response = await sgMail.send(mailOptions);

    console.log("✅ Direct SendGrid test successful!");
    console.log("📧 Response:", response[0]?.statusCode);

    res.status(200).json({
      message: "✅ Direct SendGrid test successful!",
      target_email: targetEmail,
      sendgrid_response: {
        statusCode: response[0]?.statusCode,
        messageId: response[0]?.headers?.["x-message-id"],
      },
      api_key_used: sendGridKey.substring(0, 10) + "...",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("❌ Direct SendGrid test failed:", error);

    res.status(500).json({
      message: "❌ Direct SendGrid test failed",
      error: error.message,
      error_code: error.code,
      error_response: error.response?.body,
      timestamp: new Date().toISOString(),
    });
  }
});

// Test email sending endpoint - ENHANCED VERSION
app.post("/api/debug/test-email", async (req, res) => {
  console.log("\n🧪 EMAIL TEST ENDPOINT CALLED");

  try {
    const targetEmail =
      req.body.email || process.env.SMTP_EMAIL || "qazisanaullah612@gmail.com";
    console.log("🎯 Target email:", targetEmail);

    // Import fresh every time to avoid caching issues
    delete require.cache[require.resolve("./utils/email")];
    const { sendEmail } = require("./utils/email");

    const result = await sendEmail({
      email: targetEmail,
      subject: "🧪 URGENT TEST - Leave Management Email System",
      html:
        "<h1>🎉 SUCCESS!</h1><p>If you received this, your email system is working!</p><p>Time: " +
        new Date().toISOString() +
        "</p>",
      text:
        "SUCCESS! If you received this, your email system is working! Time: " +
        new Date().toISOString(),
      category: "test",
    });

    console.log("✅ Test email completed successfully");

    res.status(200).json({
      message: "✅ Test email completed - check your inbox!",
      target_email: targetEmail,
      result: result,
      environment_check: {
        node_env: process.env.NODE_ENV,
        sendgrid_key_railway: process.env.SendGrid_Key
          ? `${process.env.SendGrid_Key.substring(0, 10)}...`
          : "NOT SET",
        sendgrid_key_standard: process.env.SENDGRID_API_KEY
          ? `${process.env.SENDGRID_API_KEY.substring(0, 10)}...`
          : "NOT SET",
        sendgrid_configured: !!(
          process.env.SendGrid_Key || process.env.SENDGRID_API_KEY
        ),
        sendgrid_key_length: (
          process.env.SendGrid_Key ||
          process.env.SENDGRID_API_KEY ||
          ""
        ).length,
        smtp_configured: !!(
          process.env.SMTP_EMAIL && process.env.SMTP_PASSWORD
        ),
        from_email: process.env.FROM_EMAIL || "NOT SET",
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("❌ Test email failed:", error.message);
    console.error("❌ Full error:", error);

    res.status(500).json({
      message: "❌ Test email failed",
      error: error.message,
      error_stack: error.stack,
      environment_check: {
        node_env: process.env.NODE_ENV,
        sendgrid_key_railway: process.env.SendGrid_Key
          ? `${process.env.SendGrid_Key.substring(0, 10)}...`
          : "NOT SET",
        sendgrid_key_standard: process.env.SENDGRID_API_KEY
          ? `${process.env.SENDGRID_API_KEY.substring(0, 10)}...`
          : "NOT SET",
        sendgrid_configured: !!(
          process.env.SendGrid_Key || process.env.SENDGRID_API_KEY
        ),
        sendgrid_key_length: (
          process.env.SendGrid_Key ||
          process.env.SENDGRID_API_KEY ||
          ""
        ).length,
        smtp_configured: !!(
          process.env.SMTP_EMAIL && process.env.SMTP_PASSWORD
        ),
        from_email: process.env.FROM_EMAIL || "NOT SET",
        smtp_email: process.env.SMTP_EMAIL || "NOT SET",
        smtp_password_exists: !!process.env.SMTP_PASSWORD,
      },
      timestamp: new Date().toISOString(),
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
    version: "1.0.0",
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
        <p>MongoDB Status: ${
          mongoose.connection.readyState === 1
            ? "✅ Connected"
            : "❌ Disconnected"
        }</p>
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
  res.redirect("/");
});

// Debug endpoint for email configuration
app.get("/api/debug/email-config", (req, res) => {
  try {
    // Check SendGrid configuration like the email utility does
    const sendGridKey =
      process.env.SendGrid_Key || process.env.SENDGRID_API_KEY;
    const isSendGridConfigured =
      sendGridKey &&
      sendGridKey !== "your_sendgrid_api_key_here" &&
      sendGridKey.length > 10;
    const isProduction = process.env.NODE_ENV === "production";
    const willUseSendGrid = isProduction && isSendGridConfigured;

    const emailConfig = {
      environment: process.env.NODE_ENV,
      is_production: isProduction,
      sendgrid_key_railway_exists: !!process.env.SendGrid_Key,
      sendgrid_key_railway_length: (process.env.SendGrid_Key || "").length,
      sendgrid_key_railway_preview: process.env.SendGrid_Key
        ? `${process.env.SendGrid_Key.substring(0, 15)}...`
        : "NOT SET",
      sendgrid_key_standard_exists: !!process.env.SENDGRID_API_KEY,
      sendgrid_key_standard_length: (process.env.SENDGRID_API_KEY || "").length,
      final_sendgrid_key_exists: !!sendGridKey,
      final_sendgrid_key_length: (sendGridKey || "").length,
      sendgrid_configured: isSendGridConfigured,
      will_use_sendgrid: willUseSendGrid,
      will_use_provider: willUseSendGrid ? "SendGrid" : "SMTP",
      from_email: process.env.FROM_EMAIL,
      smtp_email: process.env.SMTP_EMAIL,
      smtp_password_exists: !!process.env.SMTP_PASSWORD,
      timestamp: new Date().toISOString(),
      decision_logic: {
        is_production: isProduction,
        sendgrid_key_exists: !!sendGridKey,
        sendgrid_key_valid:
          sendGridKey && sendGridKey !== "your_sendgrid_api_key_here",
        sendgrid_key_long_enough: sendGridKey && sendGridKey.length > 10,
        final_decision: willUseSendGrid,
      },
    };

    res.status(200).json({
      message: "📧 Email Configuration Debug",
      config: emailConfig,
    });
  } catch (error) {
    res.status(500).json({
      message: "❌ Email config debug failed",
      error: error.message,
    });
  }
});

// Debug endpoint to check uploads directory and files
app.get("/api/debug/uploads", (req, res) => {
  try {
    const uploadsPath = path.join(__dirname, "uploads");
    const profilesPath = path.join(uploadsPath, "profiles");

    const result = {
      uploadsExists: fs.existsSync(uploadsPath),
      profilesExists: fs.existsSync(profilesPath),
      uploadsPath: uploadsPath,
      profilesPath: profilesPath,
      files: [],
    };

    if (result.profilesExists) {
      try {
        const files = fs.readdirSync(profilesPath);
        result.files = files.map((file) => ({
          name: file,
          path: `/uploads/profiles/${file}`,
          fullPath: path.join(profilesPath, file),
          stats: fs.statSync(path.join(profilesPath, file)),
        }));
      } catch (error) {
        result.error = error.message;
      }
    }

    res.status(200).json({
      message: "📁 Uploads Directory Debug",
      timestamp: new Date().toISOString(),
      data: result,
    });
  } catch (error) {
    res.status(500).json({
      message: "❌ Debug uploads failed",
      error: error.message,
      timestamp: new Date().toISOString(),
    });
  }
});

// Request logging middleware for debugging
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const duration = Date.now() - start;
    if (duration > 1000) {
      // Log slow requests
      console.log(`⏰ Slow request: ${req.method} ${req.path} - ${duration}ms`);
    }
  });
  next();
});

// Global error handler with better logging
app.use((err, req, res, next) => {
  console.error(`💥 Error in ${req.method} ${req.path}:`);
  console.error("Error message:", err.message);
  console.error("Error stack:", err.stack);

  res.status(err.status || 500).json({
    message: "Something went wrong!",
    error: process.env.NODE_ENV === "production" ? {} : err.message,
    path: req.path,
    method: req.method,
    timestamp: new Date().toISOString(),
  });
});

// 404 handler for unknown routes
app.use("*", (req, res) => {
  res.status(404).json({
    message: "Route not found",
    path: req.originalUrl,
    hint: "Try /api/test for testing or / for the main page",
  });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
