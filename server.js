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
// dashboard), this would silently fall back to loading the local dev .env -
// which has a localhost FRONTEND_URL - while still deployed for real users.
// RAILWAY_ENVIRONMENT is injected automatically by Railway on every deploy,
// so it's a reliable second signal that we're actually running in production.
const isDeployedProduction =
  process.env.NODE_ENV === "production" ||
  !!process.env.RAILWAY_ENVIRONMENT_NAME ||
  !!process.env.RAILWAY_ENVIRONMENT;
if (isDeployedProduction) {
  require("dotenv").config({
    path: path.join(__dirname, ".env.production"),
    quiet: true,
  });
  process.env.NODE_ENV = "production";
} else {
  require("dotenv").config({ quiet: true });
}

/**
 * Production console policy.
 *
 * Chatty logs are useful while developing and are noise in a deployed service:
 * they cost I/O on every request and bury the entries that matter. In
 * production everything below error is muted, so what reaches the log is what
 * actually went wrong.
 *
 * Installed here, before the first require of application code, because several
 * modules log at import time and would otherwise slip past it.
 *
 * VERBOSE_LOGS=true restores everything, so an incident can be traced without
 * deploying different code.
 */
const VERBOSE_LOGS = process.env.VERBOSE_LOGS === "true";
if (isDeployedProduction && !VERBOSE_LOGS) {
  const noop = () => {};
  console.log = noop;
  console.info = noop;
  console.debug = noop;
  console.warn = noop;
}

// Report only what is MISSING. Echoing configuration back to the log tells an
// operator nothing they cannot read from the dashboard, and every value printed
// here is one more secret sitting in a log aggregator.
//
// The email variables depend on the transport: local development sends over
// SMTP and legitimately has no Brevo key, so listing the Brevo vars
// unconditionally reported a false "MISSING ENV" on every dev boot.
const { resolveProvider } = require("./services/email/config");
const REQUIRED_ENV = [
  "JWT_SECRET",
  "MONGODB_URI",
  ...(resolveProvider() === "smtp"
    ? ["SMTP_HOST", "SMTP_EMAIL", "SMTP_PASSWORD"]
    : ["BREVO_API_KEY", "EMAIL_FROM"]),
];
const missingEnv = REQUIRED_ENV.filter((k) => !process.env[k]);

// JWT_SECRET has no fallback in utils/jwt.js, so a missing one does not fail
// here - it fails as a 500 on the first login, which is far harder to diagnose.
if (!process.env.JWT_SECRET) {
  console.error("FATAL: JWT_SECRET is not set. Refusing to start.");
  process.exit(1);
}
if (missingEnv.length) {
  // The one startup line that must survive the mute above.
  console.error(
    `Startup (${process.env.NODE_ENV || "development"}): MISSING ENV -> ${missingEnv.join(", ")}`
  );
} else {
  console.log(`Startup (${process.env.NODE_ENV || "development"}): env OK`);
}

const authRoutes = require("./routes/auth");
const leaveRoutes = require("./routes/leaves");
const userRoutes = require("./routes/users");
const attendanceRoutes = require("./routes/attendance");
const attendanceSyncRoutes = require("./routes/attendanceSync");
const biometricRoutes = require("./routes/biometric");
const employeesFixRoutes = require("./routes/employees-fix");
const employeePerformanceRoutes = require("./routes/employeePerformance");
const machinePerformanceRoutes = require("./routes/machinePerformance");
const notificationRoutes = require("./routes/notifications");
const employeeVoiceRoutes = require("./routes/employeeVoice");
const workFromHomeRoutes = require("./routes/workFromHome");
const unreportedAbsenceRoutes = require("./routes/unreportedAbsence");
const agentRoutes = require("./routes/agent");

const app = express();

// Railway (and most PaaS hosts) sit behind a reverse proxy that terminates
// TLS and forwards the real client IP via X-Forwarded-For. Without this,
// Express ignores that header, so req.ip resolves to the proxy's own IP for
// every request - which trips express-rate-limit's X-Forwarded-For sanity
// check (ERR_ERL_UNEXPECTED_X_FORWARDED_FOR) and would rate-limit/log all
// traffic as a single client. `1` trusts exactly one hop (Railway's edge
// proxy), which is the correct, spoofing-safe value here (vs `true`, which
// trusts the whole chain and would let a client forge its own IP). Must be
// set before any middleware that reads the client IP - rate limiting,
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
// Log requests that failed. A line per successful request is thousands of
// entries an hour that nobody reads; a 4xx/5xx is worth keeping.
app.use(
  morgan(isDeployedProduction && !VERBOSE_LOGS ? "tiny" : "combined", {
    skip: (req, res) =>
      isDeployedProduction && !VERBOSE_LOGS && res.statusCode < 400,
    // console.log is muted above, so write straight to the real stream.
    stream: { write: (line) => process.stdout.write(line) },
  })
);

// Rate limiting. The exemption matches req.PATH against an exact allowlist, not
// req.url against substrings: req.url carries the query string, so the old
// `includes("/test")` check let anyone opt out of rate limiting entirely by
// appending "?x=/test" - including on POST /api/auth/login.
const RATE_LIMIT_EXEMPT_PATHS = new Set(["/api/health"]);
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000,
  standardHeaders: true,
  legacyHeaders: false,
  // The Local Agent is a machine, not a browser: it holds a long-poll open
  // continuously and pushes attendance in batches, so a catch-up sync after the
  // office PC has been off is legitimately hundreds of requests in minutes. It
  // also shares the office's public IP with every employee using the app, so
  // the shared budget here throttled the agent and stalled attendance sync.
  // It gets its own, larger budget below instead of being exempted outright.
  skip: (req) =>
    RATE_LIMIT_EXEMPT_PATHS.has(req.path) || req.path.startsWith("/api/agent"),
});
app.use(limiter);

// Agent traffic still needs a ceiling: these endpoints are reachable before
// authentication runs, so an unauthenticated caller must not be able to hammer
// them without limit.
const agentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5000,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use("/api/agent", agentLimiter);

// Body parser middleware
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// Serve static files for profile pictures with better error handling
const uploadsPath = path.join(__dirname, "uploads");

// Ensure uploads directory exists
if (!fs.existsSync(uploadsPath)) {
  fs.mkdirSync(uploadsPath, { recursive: true });
  console.log("Created uploads directory");
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

// Database connection with retry logic
const connectDB = async (retryCount = 0) => {
  const maxRetries = 3;

  try {
    let connectionString;

    // Check if this is actually a production deployment. Don't rely on
    // NODE_ENV alone - it's easy to forget to add it as a Railway dashboard
    // variable, and if it's missing this used to silently fall through to
    // "FORCE LOCAL DATABASE" below, ignoring a correctly-set MONGODB_URI
    // entirely. RAILWAY_ENVIRONMENT/RAILWAY_ENVIRONMENT_NAME/RAILWAY_PROJECT_ID
    // are injected automatically by Railway on every deploy - no dashboard
    // configuration required - so treat any of them as proof we're actually
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
          "CRITICAL: MONGODB_URI is not set in the production environment."
        );
        process.exit(1);
      }
      if (isActualProduction) {
        console.log("PRODUCTION DEPLOYMENT: Using MongoDB Atlas");
      } else {
        console.log(
          "USE_PRODUCTION_DB=true - LOCAL SERVER IS USING THE LIVE ATLAS DATABASE."
        );
        console.log(
          "Reads AND WRITES affect real production records. Set it to false when done."
        );
      }
    } else {
      // FORCE LOCAL DATABASE - Ignore the production MONGODB_URI.
      // Port 27018 is this app's dedicated mongo container, so we never collide
      // with another project's mongo on the default 27017 (which requires auth).
      connectionString =
        process.env.LOCAL_MONGODB_URI ||
        "mongodb://127.0.0.1:27018/leave-management-dev";
      console.log(
        "DEVELOPMENT MODE: forcing the local database and ignoring MONGODB_URI."
      );
      console.log("Set USE_PRODUCTION_DB=true to use the live Atlas data.");
    }

    const targetLabel = isActualProduction || useProductionDB ? "ATLAS" : "LOCAL";

    // Never log `connectionString` - an Atlas URI embeds username:password, and
    // anything printed here lands in the platform's log store verbatim.
    console.log(
      `MongoDB: connecting to ${targetLabel} (attempt ${retryCount + 1}/${
        maxRetries + 1
      })`
    );
    const startTime = Date.now();

    await mongoose.connect(connectionString, {
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 10000,
      connectTimeoutMS: 5000,
      bufferCommands: false,
      maxPoolSize: 10,
    });

    const connectionTime = Date.now() - startTime;
    console.log(`${targetLabel} MongoDB connected in ${connectionTime}ms`);

    // Sanity-check the connection matches what we intended, in either direction.
    const isLocalHost =
      mongoose.connection.host === "127.0.0.1" ||
      mongoose.connection.host === "localhost";
    if (targetLabel === "ATLAS" && isLocalHost) {
      console.log("WARNING: Expected Atlas but connected to a local host.");
    } else if (targetLabel === "LOCAL" && !isLocalHost) {
      console.log("WARNING: Expected local but connected to a remote host.");
    }
  } catch (error) {
    console.error("MongoDB connection failed:");
    console.error("Error name:", error.name);
    console.error("Error message:", error.message);
    console.error("Error code:", error.code);

    if (
      error.message.includes("ECONNREFUSED") ||
      error.message.includes("connect ECONNREFUSED")
    ) {
      console.error("Connection refused - is MongoDB running?");
      console.error("Start MongoDB with one of these commands:");
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
      console.error("DNS lookup failed - network issue");
    } else if (error.message.includes("timeout")) {
      console.error("Connection timeout");
    }

    // Retry logic
    if (retryCount < maxRetries) {
      const retryDelay = (retryCount + 1) * 2000; // 2s, 4s, 6s delays
      console.log(
        `Retrying connection in ${retryDelay / 1000}s (${
          retryCount + 1
        }/${maxRetries})`
      );

      await new Promise((resolve) => setTimeout(resolve, retryDelay));
      return connectDB(retryCount + 1);
    }

    console.log(
      "All retry attempts failed. MongoDB connection could not be established."
    );
  }
};

// Connect to database
connectDB();

// Add database connection event listeners for stability
mongoose.connection.on("connected", () => {
  console.log("Mongoose connected to MongoDB");
});

mongoose.connection.on("error", (err) => {
  console.error("Mongoose connection error:", err);
});

mongoose.connection.on("disconnected", () => {
  console.log("Mongoose disconnected from MongoDB");
});

// Handle process termination gracefully
process.on("SIGINT", async () => {
  console.log("SIGINT received. Gracefully shutting down...");
  await mongoose.connection.close();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("SIGTERM received. Gracefully shutting down...");
  await mongoose.connection.close();
  process.exit(0);
});

// Handle uncaught exceptions
process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error);
  console.error("Stack trace:", error.stack);
  // Don't exit immediately - log and continue
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
  // Don't exit immediately - log and continue
});

// Routes
app.use("/api/auth", authRoutes);
app.use("/api/leaves", leaveRoutes);
app.use("/api/users", userRoutes);
app.use("/api/attendance", attendanceRoutes);
// Device-to-database sync. Previously written but never mounted, which left
// /api/attendance/sync/manual (a stub returning synced: 0) as the only reachable
// sync endpoint - so device punches never reached the database.
app.use("/api/attendance-sync", attendanceSyncRoutes);
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
app.use("/api/work-from-home", workFromHomeRoutes);
app.use("/api/unreported-absence", unreportedAbsenceRoutes);
app.use("/api/announcements", require("./routes/announcements"));
// Local ZKTeco Agent link. The device sits on a private office LAN that this
// host cannot route to, so an agent on an office PC connects outbound to these
// endpoints and relays every device operation.
app.use("/api/agent", agentRoutes);

// Health check. Railway polls this, so it must stay reachable and cheap. It
// reports liveness only - no environment, no host, no collection names. The
// former /api/debug/* and /api/test* endpoints that did report those were
// unauthenticated, exempt from rate limiting, and included an open email relay
// and an arbitrary database write; they have been removed rather than gated.
app.get("/api/health", (req, res) => {
  const connected = mongoose.connection.readyState === 1;
  res.status(connected ? 200 : 503).json({
    status: connected ? "ok" : "degraded",
    database: connected ? "connected" : "disconnected",
    timestamp: new Date().toISOString(),
  });
});

// Global error handler. Registered after every route so any next(err) lands
// here, including the 404 express.static raises for a missing upload.
app.use((err, req, res, next) => {
  console.error(`Error in ${req.method} ${req.path}:`, err.message);
  if (process.env.NODE_ENV !== "production") {
    console.error(err.stack);
  }

  res.status(err.status || err.statusCode || 500).json({
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
  });
});

const PORT = process.env.PORT || 5000;

// Real-time layer: wrap Express in an HTTP server so Socket.IO can share the
// same port, then initialise the socket server (JWT-authenticated, room-based).
const server = http.createServer(app);
require("./socket/socketServer").init(server);

// Notification layer: reports its effective channel configuration once, and
// names anything that would silently prevent WhatsApp delivery. It never
// throws - a misconfigured WhatsApp channel must not stop the server, only
// stop sending.
require("./notifications").NotificationService.init();

server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  console.log(`Real-time (Socket.IO) ready on the same port`);

  // The office rule that converts an unexplained day into leave after the
  // cutoff. Idempotent and started after the listener, so a boot at any hour
  // catches up without double-charging anyone.
  require("./services/unreportedAbsenceScheduler").start();
});
