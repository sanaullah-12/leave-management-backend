const express = require('express');
const { authenticateToken, authorizeRoles, checkCompanyAccess } = require('../middleware/auth');
const { uploadSingle, processProfilePicture } = require('../middleware/upload');
const User = require('../models/User');

const router = express.Router();

// Get all employees (Admin only)
router.get('/', authenticateToken, authorizeRoles('admin'), async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    const users = await User.find({ 
      company: req.user.company._id,
      role: 'employee'
    })
    .select('-password')
    .populate('company', 'name')
    .skip(skip)
    .limit(limit)
    .sort({ createdAt: -1 });

    const total = await User.countDocuments({ 
      company: req.user.company._id,
      role: 'employee'
    });

    res.status(200).json({
      employees: users,
      pagination: {
        current: page,
        pages: Math.ceil(total / limit),
        total
      }
    });

  } catch (error) {
    res.status(500).json({ 
      message: 'Failed to get employees', 
      error: error.message 
    });
  }
});

// Get single employee (Admin can get any, Employee can get only themselves)
router.get('/:id', authenticateToken, checkCompanyAccess, async (req, res) => {
  try {
    let query = { _id: req.params.id };
    
    // If user is not admin, they can only see their own profile
    if (req.user.role !== 'admin') {
      query._id = req.user._id;
    } else {
      // Admin can only see employees from their company
      query.company = req.user.company._id;
    }

    const user = await User.findOne(query)
      .select('-password')
      .populate('company', 'name');

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    res.status(200).json({ user });

  } catch (error) {
    res.status(500).json({ 
      message: 'Failed to get user', 
      error: error.message 
    });
  }
});

// Update employee profile (Admin can update any, Employee can update only themselves)
router.put('/:id', authenticateToken, checkCompanyAccess, async (req, res) => {
  try {
    const { name, phone, department, position } = req.body;
    
    let query = { _id: req.params.id };
    
    // If user is not admin, they can only update their own profile
    if (req.user.role !== 'admin') {
      query._id = req.user._id;
      // Employees can only update limited fields
      const allowedUpdates = { name, phone };
      Object.keys(allowedUpdates).forEach(key => 
        allowedUpdates[key] === undefined && delete allowedUpdates[key]
      );
      req.body = allowedUpdates;
    } else {
      // Admin can update more fields
      query.company = req.user.company._id;
      const allowedUpdates = { name, phone, department, position };
      Object.keys(allowedUpdates).forEach(key => 
        allowedUpdates[key] === undefined && delete allowedUpdates[key]
      );
      req.body = allowedUpdates;
    }

    const user = await User.findOneAndUpdate(
      query,
      req.body,
      { new: true, runValidators: true }
    ).select('-password').populate('company', 'name');

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    res.status(200).json({ 
      message: 'Profile updated successfully',
      user 
    });

  } catch (error) {
    res.status(500).json({ 
      message: 'Failed to update profile', 
      error: error.message 
    });
  }
});

// Deactivate employee (Admin only)
router.put('/:id/deactivate', authenticateToken, authorizeRoles('admin'), async (req, res) => {
  try {
    const user = await User.findOneAndUpdate(
      { 
        _id: req.params.id, 
        company: req.user.company._id,
        role: 'employee' // Can't deactivate other admins
      },
      { isActive: false },
      { new: true }
    ).select('-password');

    if (!user) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    res.status(200).json({ 
      message: 'Employee deactivated successfully',
      user 
    });

  } catch (error) {
    res.status(500).json({ 
      message: 'Failed to deactivate employee', 
      error: error.message 
    });
  }
});

// Activate employee (Admin only)
router.put('/:id/activate', authenticateToken, authorizeRoles('admin'), async (req, res) => {
  try {
    const user = await User.findOneAndUpdate(
      { 
        _id: req.params.id, 
        company: req.user.company._id,
        role: 'employee'
      },
      { isActive: true },
      { new: true }
    ).select('-password');

    if (!user) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    res.status(200).json({ 
      message: 'Employee activated successfully',
      user 
    });

  } catch (error) {
    res.status(500).json({ 
      message: 'Failed to activate employee', 
      error: error.message 
    });
  }
});

// Delete employee (Admin only)
router.delete('/:id', authenticateToken, authorizeRoles('admin'), async (req, res) => {
  try {
    const employeeId = req.params.id;

    // Check if employee exists and belongs to the same company
    const employee = await User.findOne({
      _id: employeeId,
      company: req.user.company._id,
      role: 'employee' // Can't delete other admins
    }).select('-password');

    if (!employee) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    // Check if employee has any pending or approved leaves
    const Leave = require('../models/Leave');
    const activeLeaves = await Leave.countDocuments({
      employee: employeeId,
      status: { $in: ['pending', 'approved'] }
    });

    if (activeLeaves > 0) {
      return res.status(400).json({ 
        message: `Cannot delete employee. They have ${activeLeaves} active leave request(s). Please resolve all leave requests first.` 
      });
    }

    // Delete all rejected/historical leaves for this employee
    await Leave.deleteMany({ employee: employeeId });

    // Delete the employee
    await User.findByIdAndDelete(employeeId);

    res.status(200).json({ 
      message: 'Employee deleted successfully',
      deletedEmployee: {
        id: employee._id,
        name: employee.name,
        email: employee.email,
        employeeId: employee.employeeId
      }
    });

  } catch (error) {
    console.error('Delete employee error:', error);
    res.status(500).json({ 
      message: 'Failed to delete employee', 
      error: error.message 
    });
  }
});

// Upload profile picture
router.post('/profile-picture', authenticateToken, uploadSingle, processProfilePicture, async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: 'No file uploaded' });
    }

    // Update user's profile picture
    const user = await User.findByIdAndUpdate(
      req.user._id,
      { profilePicture: req.profilePicturePath },
      { new: true }
    ).select('-password');

    res.status(200).json({
      message: 'Profile picture updated successfully',
      profilePicture: req.profilePicturePath,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        employeeId: user.employeeId,
        department: user.department,
        position: user.position,
        company: user.company,
        joinDate: user.joinDate,
        phone: user.phone,
        profilePicture: user.profilePicture,
        isActive: user.isActive
      }
    });

  } catch (error) {
    console.error('Profile picture upload error:', error);
    res.status(500).json({ 
      message: 'Failed to upload profile picture', 
      error: error.message 
    });
  }
});

module.exports = router;