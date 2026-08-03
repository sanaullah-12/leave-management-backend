const express = require("express");
const http = require("http");
const mongoose = require("mongoose");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");
// Load environment variables
const path = require("path");
const fs = require("fs");
// Don't trust NODE_ENV alone to pick the env file: it must be set explicitly
// on the host, and if it's ever missing (e.g. not configured in the Railway
// dashboard), this would silently fall back to loading the local dev .env —
// which has a localhost FRONTEND_URL — while still deployed for real users.
// RAILWAY_ENVIRONMENT is injected automatically by Railway on every deploy,
// so it's a reliable second signal that we're actually running in production.
const isDeployedProduction =
  process.env.NODE_ENV === "production" ||
  !!process.env.RAILWAY_ENVIRONMENT_NAME ||
  !!process.env.RAILWAY_ENVIRONMENT;
if (isDeployedProduction) {
  require("dotenv").config({ path: path.join(__dirname, ".env.production") });
  process.env.NODE_ENV = "production";
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
const notificationRoutes = require("./routes/notifications");
const employeeVoiceRoutes = require("./routes/employeeVoice");

const app = express();

// Railway (and most PaaS hosts) sit behind a reverse proxy that terminates
// TLS and forwards the real client IP via X-Forwarded-For. Without this,
// Express ignores that header, so req.ip resolves to the proxy's own IP for
// every request — which trips express-rate-limit's X-Forwarded-For sanity
// check (ERR_ERL_UNEXPECTED_X_FORWARDED_FOR) and would rate-limit/log all
// traffic as a single client. `1` trusts exactly one hop (Railway's edge
// proxy), which is the correct, spoofing-safe value here (vs `true`, which
// trusts the whole chain and would let a client forge its own IP). Must be
// set before any middleware that reads the client IP — rate limiting,
// request logging (morgan), and auth all sit below this line.
app.set("trust proxy", 1);

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

    // Check if this is actually a production deployment. Don't rely on
    // NODE_ENV alone — it's easy to forget to add it as a Railway dashboard
    // variable, and if it's missing this used to silently fall through to
    // "FORCE LOCAL DATABASE" below, ignoring a correctly-set MONGODB_URI
    // entirely. RAILWAY_ENVIRONMENT/RAILWAY_ENVIRONMENT_NAME/RAILWAY_PROJECT_ID
    // are injected automatically by Railway on every deploy — no dashboard
    // configuration required — so treat any of them as proof we're actually
    // running on Railway (there is no local Mongo container there to fall
    // back to anyway).
    const isActualProduction =
      process.env.NODE_ENV === "production" ||
      !!process.env.RAILWAY_ENVIRONMENT_NAME ||
      !!process.env.RAILWAY_ENVIRONMENT ||
      !!process.env.RAILWAY_PROJECT_ID;

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

    const targetLabel = isActualProduction || useProductionDB ? "ATLAS" : "LOCAL";
    console.log(`📡 Attempting to connect to ${targetLabel} MongoDB...`);
    const startTime = Date.now();

    await mongoose.connect(connectionString, {
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 10000,
      connectTimeoutMS: 5000,
      bufferCommands: false,
      maxPoolSize: 10,
    });

    const connectionTime = Date.now() - startTime;
    console.log(`✅ ${targetLabel} MongoDB connected successfully!`);
    console.log(`Connection time: ${connectionTime}ms`);
    console.log("Database name:", mongoose.connection.db.databaseName);
    console.log("Connection host:", mongoose.connection.host);
    console.log("Connection ready state:", mongoose.connection.readyState);

    // Sanity-check the connection matches what we intended, in either direction.
    const isLocalHost =
      mongoose.connection.host === "127.0.0.1" ||
      mongoose.connection.host === "localhost";
    if (targetLabel === "ATLAS" && isLocalHost) {
      console.log(
        "⚠️  WARNING: Expected Atlas but connected to a local host:",
        mongoose.connection.host
      );
    } else if (targetLabel === "LOCAL" && !isLocalHost) {
      console.log(
        "⚠️  WARNING: Expected local but connected to a remote host:",
        mongoose.connection.host
      );
    } else {
      console.log(`✅ CONFIRMED: Connected to ${targetLabel} database as intended`);
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
app.use("/api/notifications", notificationRoutes);
app.use("/api/employee-voice", employeeVoiceRoutes);
app.use("/api/announcements", require("./routes/announcements"));

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

// SendGrid test endpoint — disabled. SMTP is the only email path in production now.
app.post("/api/debug/test-sendgrid", async (req, res) => {
  res.status(410).json({
    message: "SendGrid is disabled. This deployment sends email via SMTP only.",
  });
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
        provider: "SMTP",
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
        provider: "SMTP",
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
    // SendGrid is disabled — SMTP is the only email path, in every environment.
    const isProduction = process.env.NODE_ENV === "production";

    const emailConfig = {
      environment: process.env.NODE_ENV,
      is_production: isProduction,
      will_use_provider: "SMTP",
      smtp_host: process.env.SMTP_HOST,
      smtp_port: process.env.SMTP_PORT,
      from_email: process.env.FROM_EMAIL,
      smtp_email: process.env.SMTP_EMAIL,
      smtp_password_exists: !!process.env.SMTP_PASSWORD,
      smtp_configured: !!(
        process.env.SMTP_HOST &&
        process.env.SMTP_EMAIL &&
        process.env.SMTP_PASSWORD
      ),
      timestamp: new Date().toISOString(),
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

// Real-time layer: wrap Express in an HTTP server so Socket.IO can share the
// same port, then initialise the socket server (JWT-authenticated, room-based).
const server = http.createServer(app);
require("./socket/socketServer").init(server);

server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  console.log(`⚡ Real-time (Socket.IO) ready on the same port`);
});
