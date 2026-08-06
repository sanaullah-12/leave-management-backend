require("dotenv").config();
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

// Import models
const User = require("./models/User");
const Company = require("./models/Company");

async function createTestAdmin() {
  try {
    // Connect to MongoDB
    // Use the LOCAL dev database, not the production Atlas MONGODB_URI.
    await mongoose.connect(
      process.env.LOCAL_MONGODB_URI ||
        "mongodb://127.0.0.1:27018/leave-management-dev"
    );
    console.log("Connected to MongoDB");

    // Check if admin already exists
    const existingAdmin = await User.findOne({ email: "admin@company.com" });
    if (existingAdmin) {
      console.log("Admin user already exists");
      return existingAdmin;
    }

    // Create company first
    const existingCompany = await Company.findOne({ name: "Test Company" });
    let company = existingCompany;

    if (!company) {
      company = new Company({
        name: "Test Company",
        email: "company@test.com",
        industry: "Technology",
        size: "50-100",
        timezone: "Asia/Karachi",
      });
      await company.save();
      console.log("Company created");
    } else {
      console.log("Company already exists");
    }

    // Create admin user.
    // Pass the PLAIN password: the User model's pre("save") hook hashes it.
    // Hashing here too would double-hash it and make login always fail.
    const admin = new User({
      name: "Admin User",
      firstName: "Admin",
      lastName: "User",
      email: "admin@company.com",
      password: "admin123",
      role: "admin",
      company: company._id,
      // Login requires status === "active"; the schema defaults it to "pending",
      // so it must be set explicitly or this seeded admin can never sign in.
      status: "active",
      isActive: true,
      phoneNumber: "+92123456789",
      department: "Administration",
      position: "System Administrator",
      joinDate: new Date(),
      salary: 100000,
    });

    await admin.save();
    console.log("Admin user created successfully");
    console.log("Email: admin@company.com");
    console.log("Password: admin123");

    return admin;
  } catch (error) {
    console.error("Error creating admin:", error.message);
  } finally {
    await mongoose.disconnect();
    console.log("Disconnected from MongoDB");
  }
}

createTestAdmin();
