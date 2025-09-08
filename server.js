const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");
require("dotenv").config();

const authRoutes = require("./routes/auth");
const leaveRoutes = require("./routes/leaves");
const userRoutes = require("./routes/users");
const notificationRoutes = require("./routes/notifications");

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

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 500, // limit each IP to 500 requests per windowMs (increased for real-time features)
});
app.use(limiter);

// Body parser middleware
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// Serve static files for profile pictures
app.use("/uploads", express.static("uploads"));

// Database connection
mongoose
  .connect(
    process.env.MONGODB_URI || "mongodb://localhost:27017/leave-management"
  )
  .then(() => console.log("MongoDB connected"))
  .catch((err) => console.log("MongoDB connection error:", err));

// Routes
app.use("/api/auth", authRoutes);
app.use("/api/leaves", leaveRoutes);
app.use("/api/users", userRoutes);
app.use("/api/notifications", notificationRoutes);

// Health check route
app.get("/api/health", (req, res) => {
  res.status(200).json({ message: "Server is running" });
});

// Test endpoint for deployment verification
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

// Global error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({
    message: "Something went wrong!",
    error: process.env.NODE_ENV === "production" ? {} : err.message,
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
