require('dotenv').config();
const mongoose = require('mongoose');
const User = require('./models/User');
const Company = require('./models/Company');
const bcrypt = require('bcryptjs');

async function createTestAdmin() {
  try {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/leave-management-dev');

    // Check if admin already exists
    const existingAdmin = await User.findOne({ email: 'test.admin@example.com' });
    if (existingAdmin) {
      console.log('✅ Test admin already exists');
      console.log('Email: test.admin@example.com');
      console.log('Password: testpassword123');
      process.exit(0);
    }

    // Create test company
    let company = await Company.findOne({ name: 'Test Company' });
    if (!company) {
      company = new Company({
        name: 'Test Company',
        domain: 'testcompany.com',
        phone: '123-456-7890',
        address: '123 Test St'
      });
      await company.save();
    }

    // Create test admin
    const hashedPassword = await bcrypt.hash('testpassword123', 12);
    const admin = new User({
      name: 'Test Admin',
      email: 'test.admin@example.com',
      password: hashedPassword,
      role: 'admin',
      department: 'Administration',
      position: 'Administrator',
      company: company._id,
      status: 'active',
      joinDate: new Date()
    });

    await admin.save();
    console.log('✅ Test admin created successfully');
    console.log('Email: test.admin@example.com');
    console.log('Password: testpassword123');
    console.log('Company:', company.name);

  } catch (error) {
    console.error('❌ Error creating admin:', error.message);
  }
  process.exit(0);
}

createTestAdmin();