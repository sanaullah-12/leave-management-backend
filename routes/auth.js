const express = require('express');
const { generateToken } = require('../utils/jwt');
const { authenticateToken } = require('../middleware/auth');
const User = require('../models/User');
const Company = require('../models/Company');

const router = express.Router();

// Register company admin
router.post('/register-company', async (req, res) => {
  console.log('=== REGISTRATION REQUEST ===');
  console.log('Request body:', req.body);
  console.log('Headers:', req.headers);
  console.log('MongoDB status:', require('mongoose').connection.readyState);
  
  try {
    const { companyName, companyEmail, adminName, adminEmail, password, phone } = req.body;
    
    // Validate required fields
    if (!companyName || !companyEmail || !adminName || !adminEmail || !password) {
      console.log('Missing required fields');
      return res.status(400).json({
        message: 'Missing required fields',
        required: ['companyName', 'companyEmail', 'adminName', 'adminEmail', 'password']
      });
    }

    // Check if company already exists
    const existingCompany = await Company.findOne({ 
      $or: [{ name: companyName }, { email: companyEmail }] 
    });
    if (existingCompany) {
      return res.status(400).json({ message: 'Company already exists' });
    }

    // Check if admin email already exists
    const existingUser = await User.findOne({ email: adminEmail });
    if (existingUser) {
      return res.status(400).json({ message: 'Email already registered' });
    }

    // Create company
    const company = new Company({
      name: companyName,
      email: companyEmail,
      phone
    });
    await company.save();

    // Create admin user
    const admin = new User({
      name: adminName,
      email: adminEmail,
      password,
      role: 'admin',
      employeeId: 'ADMIN001',
      department: 'Administration',
      position: 'Administrator',
      joinDate: new Date(),
      company: company._id,
      phone: phone || '',
      status: 'active', // Admin is automatically active when creating company
      isActive: true // Ensure admin is active
    });
    
    console.log('Creating admin user with data:', {
      name: adminName,
      email: adminEmail,
      role: 'admin',
      department: 'Administration',
      position: 'Administrator',
      status: 'active'
    });
    
    await admin.save();
    console.log('Admin user created successfully:', admin._id);

    // Generate token
    const token = generateToken({ 
      id: admin._id, 
      role: admin.role,
      company: company._id 
    });

    res.status(201).json({
      message: 'Company registered successfully',
      token,
      user: {
        id: admin._id,
        name: admin.name,
        email: admin.email,
        role: admin.role,
        company: company.name
      }
    });

  } catch (error) {
    console.error('Registration error:', error);
    console.error('Error stack:', error.stack);
    console.error('Request body:', req.body);
    
    // Handle specific validation errors
    if (error.name === 'ValidationError') {
      const validationErrors = Object.values(error.errors).map(err => err.message);
      return res.status(400).json({ 
        message: 'Validation failed', 
        errors: validationErrors 
      });
    }
    
    // Handle MongoDB duplicate key errors
    if (error.code === 11000) {
      const field = Object.keys(error.keyValue)[0];
      return res.status(400).json({ 
        message: `${field} already exists`,
        error: `Duplicate ${field}: ${error.keyValue[field]}`
      });
    }
    
    res.status(500).json({ 
      message: 'Registration failed', 
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// Login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    // Find user and include password for comparison
    const user = await User.findOne({ email }).select('+password').populate('company');

    if (!user || !user.isActive) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    if (user.status !== 'active') {
      return res.status(401).json({ message: 'Account not verified. Please check your email for verification link.' });
    }

    // Check password
    const isPasswordValid = await user.comparePassword(password);
    if (!isPasswordValid) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    // Generate token
    const token = generateToken({ 
      id: user._id, 
      role: user.role,
      company: user.company._id 
    });

    res.status(200).json({
      message: 'Login successful',
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        employeeId: user.employeeId,
        department: user.department,
        position: user.position,
        company: user.company.name
      }
    });

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ 
      message: 'Login failed', 
      error: error.message 
    });
  }
});

// Invite employee
router.post('/invite-employee', authenticateToken, async (req, res) => {
  try {
    // Only admins can invite employees
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Only admins can invite employees' });
    }

    const { name, email, department, position, joinDate } = req.body;

    // Check if email already exists
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ message: 'Email already registered' });
    }

    // Create employee with pending status (no password yet)
    const employee = new User({
      name,
      email,
      role: 'employee',
      department,
      position,
      joinDate: new Date(joinDate),
      company: req.user.company,
      invitedBy: req.user._id,
      status: 'pending'
    });

    // Generate invitation token
    const invitationToken = employee.generateInvitationToken();
    
    await employee.save();

    // Send invitation email
    const { sendInvitationEmail } = require('../utils/email');
    console.log('🚀 Sending invitation email to:', email);
    
    try {
      await sendInvitationEmail(
        {
          ...employee.toObject(),
          company: req.user.company.name
        },
        invitationToken,
        req.user.name,
        'employee'
      );

      console.log('✅ Invitation email sent successfully');
      res.status(201).json({
        message: 'Employee invitation sent successfully',
        employee: {
          id: employee._id,
          name: employee.name,
          email: employee.email,
          employeeId: employee.employeeId,
          department: employee.department,
          position: employee.position,
          status: employee.status
        }
      });

    } catch (emailError) {
      console.error('❌ Email sending error:', emailError.message);
      
      // Return success but with email warning
      return res.status(500).json({
        message: 'Employee invitation created, but email delivery failed.',
        error: emailError.message,
        stack: emailError.stack,
        invitationToken: invitationToken, // Include token for manual sharing
        manualInviteUrl: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/verify-invitation/${invitationToken}`,
      });
    }

  } catch (error) {
    console.error('Invite error:', error);
    res.status(500).json({ 
      message: 'Failed to invite employee', 
      error: error.message 
    });
  }
});

// Invite admin
router.post('/invite-admin', authenticateToken, async (req, res) => {
  try {
    // Only admins can invite other admins
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Only admins can invite other admins' });
    }

    const { name, email, department = 'Administration', position = 'Administrator' } = req.body;

    // Check if email already exists
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ message: 'Email already registered' });
    }

    // Create admin with pending status
    const admin = new User({
      name,
      email,
      role: 'admin',
      department,
      position,
      joinDate: new Date(),
      company: req.user.company,
      invitedBy: req.user._id,
      status: 'pending'
    });

    // Generate invitation token
    const invitationToken = admin.generateInvitationToken();
    
    await admin.save();

    // Send invitation email
    const { sendInvitationEmail } = require('../utils/email');
    console.log('🚀 Sending admin invitation email to:', email);
    
    try {
      await sendInvitationEmail(
        {
          ...admin.toObject(),
          company: req.user.company.name
        },
        invitationToken,
        req.user.name,
        'admin'
      );

      console.log('✅ Admin invitation email sent successfully');
      res.status(201).json({
        message: 'Admin invitation sent successfully',
        admin: {
          id: admin._id,
          name: admin.name,
          email: admin.email,
          employeeId: admin.employeeId,
          department: admin.department,
          position: admin.position,
          status: admin.status
        }
      });

    } catch (emailError) {
      console.error('❌ Admin email sending error:', emailError.message);
      
      // Return success but with email warning
      return res.status(500).json({
        message: 'Admin invitation created, but email delivery failed.',
        error: emailError.message,
        stack: emailError.stack,
        invitationToken: invitationToken,
        manualInviteUrl: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/verify-invitation/${invitationToken}`,
      });
    }

  } catch (error) {
    console.error('Invite admin error:', error);
    res.status(500).json({ 
      message: 'Failed to invite admin', 
      error: error.message 
    });
  }
});

// Get current user profile
router.get('/profile', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user._id).populate('company');
    
    res.status(200).json({
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        employeeId: user.employeeId,
        department: user.department,
        position: user.position,
        joinDate: user.joinDate,
        company: user.company.name
      }
    });
  } catch (error) {
    res.status(500).json({ message: 'Failed to get profile', error: error.message });
  }
});

// Verify invitation and set password
router.post('/verify-invitation/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const { password } = req.body;

    if (!password) {
      return res.status(400).json({ message: 'Password is required' });
    }

    if (password.length < 6) {
      return res.status(400).json({ message: 'Password must be at least 6 characters long' });
    }

    // Hash the token to compare with database
    const crypto = require('crypto');
    const hashedToken = crypto.createHash('sha256').update(token).digest('hex');

    // Find user by invitation token
    const user = await User.findOne({
      invitationToken: hashedToken,
      invitationExpires: { $gt: Date.now() }
    }).populate('company');

    if (!user) {
      return res.status(400).json({ message: 'Invalid or expired invitation token' });
    }

    // Set password and activate user
    user.password = password;
    user.status = 'active';
    user.invitationToken = undefined;
    user.invitationExpires = undefined;
    
    await user.save();

    // Generate JWT token
    const jwtToken = generateToken({ 
      id: user._id, 
      role: user.role,
      company: user.company._id 
    });

    // Send notification to admins about employee joining
    const { sendEmployeeJoinedNotification } = require('../utils/email');
    const admins = await User.find({ 
      company: user.company._id, 
      role: 'admin', 
      status: 'active' 
    });

    for (const admin of admins) {
      try {
        await sendEmployeeJoinedNotification(admin, user);
      } catch (emailError) {
        console.error('Failed to send employee joined notification:', emailError);
      }
    }

    res.status(200).json({
      message: 'Account verified successfully',
      token: jwtToken,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        employeeId: user.employeeId,
        department: user.department,
        position: user.position,
        company: user.company.name,
        status: user.status
      }
    });

  } catch (error) {
    console.error('Verification error:', error);
    res.status(500).json({ 
      message: 'Failed to verify invitation', 
      error: error.message 
    });
  }
});

// Get invitation details (for verification page)
router.get('/invitation/:token', async (req, res) => {
  try {
    const { token } = req.params;

    // Hash the token to compare with database
    const crypto = require('crypto');
    const hashedToken = crypto.createHash('sha256').update(token).digest('hex');

    // Find user by invitation token
    const user = await User.findOne({
      invitationToken: hashedToken,
      invitationExpires: { $gt: Date.now() }
    }).populate('company').populate('invitedBy', 'name');

    if (!user) {
      return res.status(400).json({ message: 'Invalid or expired invitation token' });
    }

    res.status(200).json({
      user: {
        name: user.name,
        email: user.email,
        role: user.role,
        department: user.department,
        position: user.position,
        company: user.company.name,
        invitedBy: user.invitedBy.name
      }
    });

  } catch (error) {
    console.error('Get invitation error:', error);
    res.status(500).json({ 
      message: 'Failed to get invitation details', 
      error: error.message 
    });
  }
});

// Forgot password - Request reset link
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ message: 'Email is required' });
    }

    // Find user by email
    const user = await User.findOne({ 
      email: email.toLowerCase(),
      status: 'active' // Only active users can reset password
    }).populate('company');

    if (!user) {
      // For security, always send success response even if user doesn't exist
      return res.status(200).json({ 
        message: 'If an account exists with that email, you will receive a password reset link shortly.' 
      });
    }

    // Generate password reset token
    const resetToken = user.generatePasswordResetToken();
    await user.save();

    // Send password reset email
    const { sendPasswordResetEmail } = require('../utils/email');
    await sendPasswordResetEmail(
      {
        ...user.toObject(),
        company: user.company.name
      },
      resetToken
    );

    res.status(200).json({
      message: 'If an account exists with that email, you will receive a password reset link shortly.'
    });

  } catch (error) {
    console.error('Forgot password error:', error);
    res.status(500).json({ 
      message: 'Failed to process password reset request', 
      error: error.message 
    });
  }
});

// Reset password with token
router.post('/reset-password/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const { password } = req.body;

    if (!password) {
      return res.status(400).json({ message: 'Password is required' });
    }

    if (password.length < 6) {
      return res.status(400).json({ message: 'Password must be at least 6 characters long' });
    }

    // Hash the token to compare with database
    const crypto = require('crypto');
    const hashedToken = crypto.createHash('sha256').update(token).digest('hex');

    // Find user by reset token
    const user = await User.findOne({
      passwordResetToken: hashedToken,
      passwordResetExpires: { $gt: Date.now() }
    });

    if (!user) {
      return res.status(400).json({ message: 'Invalid or expired password reset token' });
    }

    // Update password and clear reset fields
    user.password = password;
    user.passwordResetToken = undefined;
    user.passwordResetExpires = undefined;
    
    await user.save();

    res.status(200).json({
      message: 'Password reset successfully. You can now log in with your new password.'
    });

  } catch (error) {
    console.error('Reset password error:', error);
    res.status(500).json({ 
      message: 'Failed to reset password', 
      error: error.message 
    });
  }
});

// Validate reset token (for frontend to check if token is valid)
router.get('/reset-password/:token', async (req, res) => {
  try {
    const { token } = req.params;

    // Hash the token to compare with database
    const crypto = require('crypto');
    const hashedToken = crypto.createHash('sha256').update(token).digest('hex');

    // Find user by reset token
    const user = await User.findOne({
      passwordResetToken: hashedToken,
      passwordResetExpires: { $gt: Date.now() }
    }).select('name email');

    if (!user) {
      return res.status(400).json({ message: 'Invalid or expired password reset token' });
    }

    res.status(200).json({
      valid: true,
      user: {
        name: user.name,
        email: user.email
      }
    });

  } catch (error) {
    console.error('Validate reset token error:', error);
    res.status(500).json({ 
      message: 'Failed to validate reset token', 
      error: error.message 
    });
  }
});

// Change password (for authenticated users)
router.put('/change-password', authenticateToken, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    const user = await User.findById(req.user._id).select('+password');
    
    // Verify current password
    const isPasswordValid = await user.comparePassword(currentPassword);
    if (!isPasswordValid) {
      return res.status(400).json({ message: 'Current password is incorrect' });
    }

    // Update password
    user.password = newPassword;
    await user.save();

    res.status(200).json({ message: 'Password changed successfully' });

  } catch (error) {
    res.status(500).json({ 
      message: 'Failed to change password', 
      error: error.message 
    });
  }
});

// Update employee leave quota (Admin only)
router.put('/leave-quota/:employeeId', authenticateToken, async (req, res) => {
  try {
    // Only admins can set leave quotas
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Only admins can set leave quotas' });
    }

    const { employeeId } = req.params;
    const { leaveQuota } = req.body;

    // Find employee in the same company
    const employee = await User.findOne({ 
      _id: employeeId, 
      company: req.user.company._id 
    });

    if (!employee) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    // Update leave quota
    employee.leaveQuota = { ...employee.leaveQuota, ...leaveQuota };
    await employee.save();

    res.status(200).json({
      message: 'Leave quota updated successfully',
      employee: {
        id: employee._id,
        name: employee.name,
        email: employee.email,
        leaveQuota: employee.leaveQuota
      }
    });

  } catch (error) {
    console.error('Update leave quota error:', error);
    res.status(500).json({ 
      message: 'Failed to update leave quota', 
      error: error.message 
    });
  }
});

// Get employee leave balance
router.get('/leave-balance/:employeeId?', authenticateToken, async (req, res) => {
  try {
    const { employeeId } = req.params;
    let targetUserId;

    // If employeeId is provided and user is admin, get that employee's balance
    // Otherwise, get current user's balance
    if (employeeId && req.user.role === 'admin') {
      const employee = await User.findOne({ 
        _id: employeeId, 
        company: req.user.company._id 
      });
      if (!employee) {
        return res.status(404).json({ message: 'Employee not found' });
      }
      targetUserId = employee._id;
    } else {
      targetUserId = req.user._id;
    }

    const user = await User.findById(targetUserId);
    const leaveBalances = await user.getAllLeaveBalances();

    res.status(200).json({
      employeeId: targetUserId,
      name: user.name,
      leaveBalances
    });

  } catch (error) {
    console.error('Get leave balance error:', error);
    res.status(500).json({ 
      message: 'Failed to get leave balance', 
      error: error.message 
    });
  }
});

module.exports = router;