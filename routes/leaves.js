const express = require('express');
const { authenticateToken, authorizeRoles, checkCompanyAccess } = require('../middleware/auth');
const Leave = require('../models/Leave');
const User = require('../models/User');
const { notifyLeaveRequest, notifyLeaveApproval, notifyLeaveRejection } = require('../utils/notifications');

const router = express.Router();

// Submit leave request (Employee only)
router.post('/', authenticateToken, async (req, res) => {
  try {
    const { leaveType, startDate, endDate, reason } = req.body;

    // Validate dates
    const start = new Date(startDate);
    const end = new Date(endDate);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    if (start < today) {
      return res.status(400).json({ message: 'Start date cannot be in the past' });
    }

    if (end < start) {
      return res.status(400).json({ message: 'End date must be after start date' });
    }

    // Check for overlapping leaves for the same employee
    const overlappingLeave = await Leave.findOne({
      employee: req.user._id,
      status: { $in: ['pending', 'approved'] },
      $or: [
        {
          startDate: { $lte: end },
          endDate: { $gte: start }
        }
      ]
    });

    if (overlappingLeave) {
      return res.status(400).json({ 
        message: 'You have overlapping leave requests for these dates' 
      });
    }

    // Get company leave policy to check for company-wide overlap restrictions
    const User = require('../models/User');
    const Company = require('../models/Company');
    const company = await Company.findById(req.user.company._id);
    
    if (!company) {
      return res.status(400).json({ message: 'Company not found' });
    }

    // Check for company-wide overlapping leaves if policy requires it
    if (company.leavePolicy?.preventOverlappingLeaves) {
      const companyOverlappingLeaves = await Leave.find({
        company: req.user.company._id,
        employee: { $ne: req.user._id }, // Exclude current user
        status: { $in: ['pending', 'approved'] },
        $or: [
          {
            startDate: { $lte: end },
            endDate: { $gte: start }
          }
        ]
      }).populate('employee', 'name employeeId profilePicture');

      if (companyOverlappingLeaves.length > 0) {
        const conflictingEmployees = companyOverlappingLeaves.map(leave => 
          `${leave.employee.name} (${leave.employee.employeeId})`
        ).join(', ');
        
        return res.status(400).json({ 
          message: `Cannot approve leave request. The following employees already have leave during these dates: ${conflictingEmployees}. Company policy prevents overlapping leaves.`
        });
      }
    }

    // Check for maximum concurrent leaves limit
    if (company.leavePolicy?.maxConcurrentLeaves && company.leavePolicy.maxConcurrentLeaves > 0) {
      const concurrentLeaves = await Leave.countDocuments({
        company: req.user.company._id,
        employee: { $ne: req.user._id },
        status: { $in: ['pending', 'approved'] },
        $or: [
          {
            startDate: { $lte: end },
            endDate: { $gte: start }
          }
        ]
      });

      if (concurrentLeaves >= company.leavePolicy.maxConcurrentLeaves) {
        return res.status(400).json({ 
          message: `Cannot submit leave request. Maximum ${company.leavePolicy.maxConcurrentLeaves} employees can be on leave simultaneously during these dates. Currently ${concurrentLeaves} employees have leave approved/pending.`
        });
      }
    }

    // Calculate requested days
    const timeDiff = end.getTime() - start.getTime();
    const requestedDays = Math.ceil(timeDiff / (1000 * 3600 * 24)) + 1;

    // Check leave balance/quota
    const user = await User.findById(req.user._id);
    const leaveBalance = await user.getLeaveBalance(leaveType);
    
    if (leaveType !== 'unpaid' && requestedDays > leaveBalance.remaining) {
      return res.status(400).json({ 
        message: `Insufficient leave balance. You have ${leaveBalance.remaining} ${leaveType} days remaining, but requested ${requestedDays} days.` 
      });
    }

    // Create leave request
    const leave = new Leave({
      employee: req.user._id,
      company: req.user.company._id,
      leaveType,
      startDate: start,
      endDate: end,
      reason
    });

    await leave.save();
    await leave.populate('employee', 'name employeeId department profilePicture');

    // Send notification to admins
    const { sendLeaveRequestNotification } = require('../utils/email');
    const admins = await User.find({ 
      company: req.user.company._id, 
      role: 'admin', 
      status: 'active' 
    }).populate('company');

    for (const admin of admins) {
      try {
        await sendLeaveRequestNotification(admin, user, leave);
        // Create in-app notification
        await notifyLeaveRequest(leave, admin);
      } catch (emailError) {
        console.error('Failed to send email notification:', emailError);
      }
    }

    res.status(201).json({
      message: 'Leave request submitted successfully',
      leave
    });

  } catch (error) {
    console.error('Leave submission error:', error);
    res.status(500).json({ 
      message: 'Failed to submit leave request', 
      error: error.message 
    });
  }
});

// Get leave requests
router.get('/', authenticateToken, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;
    const status = req.query.status;
    const employeeId = req.query.employeeId;

    let query = { company: req.user.company._id };

    // If employee, only show their own leaves
    if (req.user.role === 'employee') {
      query.employee = req.user._id;
    } else if (employeeId) {
      // Admin can filter by specific employee
      query.employee = employeeId;
    }

    // Filter by status if provided
    if (status && ['pending', 'approved', 'rejected'].includes(status)) {
      query.status = status;
    }

    const leaves = await Leave.find(query)
      .populate('employee', 'name employeeId department position profilePicture')
      .populate('reviewedBy', 'name')
      .skip(skip)
      .limit(limit)
      .sort({ appliedDate: -1 });

    const total = await Leave.countDocuments(query);

    res.status(200).json({
      leaves,
      pagination: {
        current: page,
        pages: Math.ceil(total / limit),
        total
      }
    });

  } catch (error) {
    res.status(500).json({ 
      message: 'Failed to get leave requests', 
      error: error.message 
    });
  }
});

// Get single leave request
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    let query = { _id: req.params.id, company: req.user.company._id };

    // If employee, only show their own leave
    if (req.user.role === 'employee') {
      query.employee = req.user._id;
    }

    const leave = await Leave.findOne(query)
      .populate('employee', 'name employeeId department position profilePicture')
      .populate('reviewedBy', 'name');

    if (!leave) {
      return res.status(404).json({ message: 'Leave request not found' });
    }

    res.status(200).json({ leave });

  } catch (error) {
    res.status(500).json({ 
      message: 'Failed to get leave request', 
      error: error.message 
    });
  }
});

// Approve/Reject leave request (Admin only)
router.put('/:id/review', authenticateToken, authorizeRoles('admin'), async (req, res) => {
  try {
    const { status, reviewComments } = req.body;

    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ message: 'Status must be approved or rejected' });
    }

    const leave = await Leave.findOneAndUpdate(
      { 
        _id: req.params.id, 
        company: req.user.company._id,
        status: 'pending' // Only pending leaves can be reviewed
      },
      {
        status,
        reviewedBy: req.user._id,
        reviewedDate: new Date(),
        reviewComments
      },
      { new: true }
    ).populate('employee', 'name employeeId department email profilePicture')
     .populate('reviewedBy', 'name')
     .populate('company', 'name');

    if (!leave) {
      return res.status(404).json({ 
        message: 'Leave request not found or already reviewed' 
      });
    }

    // Send email notification to employee
    const { sendLeaveStatusNotification } = require('../utils/email');
    try {
      await sendLeaveStatusNotification(leave.employee, leave, req.user);
      
      // Create in-app notification
      if (status === 'approved') {
        await notifyLeaveApproval(leave, leave.employee);
      } else if (status === 'rejected') {
        await notifyLeaveRejection(leave, leave.employee, reviewComments);
      }
    } catch (emailError) {
      console.error('Failed to send leave status notification:', emailError);
    }

    res.status(200).json({
      message: `Leave request ${status} successfully`,
      leave
    });

  } catch (error) {
    res.status(500).json({ 
      message: 'Failed to review leave request', 
      error: error.message 
    });
  }
});

// Delete leave request (Admin only - for emergencies)
router.delete('/:id', authenticateToken, authorizeRoles('admin'), async (req, res) => {
  try {
    const leave = await Leave.findOneAndDelete({
      _id: req.params.id,
      company: req.user.company._id
    }).populate('employee', 'name email profilePicture');

    if (!leave) {
      return res.status(404).json({ message: 'Leave request not found' });
    }

    res.status(200).json({
      message: 'Leave request deleted successfully'
    });

  } catch (error) {
    res.status(500).json({ 
      message: 'Failed to delete leave request', 
      error: error.message 
    });
  }
});

// Get leave balance for current user
router.get('/balance', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const currentYear = new Date().getFullYear();
    
    // Calculate leave balances manually to avoid circular dependency
    const leaveTypes = ['annual', 'sick', 'casual'];
    const balances = {};
    
    for (const type of leaveTypes) {
      // Get used leaves for this type in current year
      const usedLeaves = await Leave.aggregate([
        {
          $match: {
            employee: user._id,
            leaveType: type,
            status: 'approved',
            startDate: {
              $gte: new Date(currentYear, 0, 1),
              $lt: new Date(currentYear + 1, 0, 1)
            }
          }
        },
        {
          $group: {
            _id: null,
            totalDays: { $sum: '$totalDays' }
          }
        }
      ]);
      
      const usedDays = usedLeaves.length > 0 ? usedLeaves[0].totalDays : 0;
      const quota = user.leaveQuota[type] || 0;
      
      balances[type] = {
        total: quota,
        used: usedDays,
        remaining: Math.max(0, quota - usedDays)
      };
    }

    const response = {
      employee: {
        id: user._id,
        name: user.name,
        employeeId: user.employeeId
      },
      year: currentYear,
      balance: balances
    };

    res.status(200).json(response);

  } catch (error) {
    console.error('=== BALANCE ERROR ===');
    console.error('Leave balance error for user:', req.user?._id);
    console.error('Error message:', error.message);
    console.error('Error stack:', error.stack);
    console.error('=== BALANCE ERROR END ===');
    res.status(500).json({ 
      message: 'Failed to get leave balance', 
      error: error.message 
    });
  }
});

// Get leave balance for employee
router.get('/balance/:employeeId', authenticateToken, async (req, res) => {
  try {
    let employeeId = req.params.employeeId;
    
    // If employee, they can only see their own balance
    if (req.user.role === 'employee') {
      employeeId = req.user._id;
    } else if (!employeeId) {
      return res.status(400).json({ message: 'Employee ID required' });
    }

    // Verify employee belongs to the same company
    const employee = await User.findOne({
      _id: employeeId,
      company: req.user.company._id
    }).populate('company');

    if (!employee) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    // Calculate current year leaves
    const currentYear = new Date().getFullYear();
    const yearStart = new Date(currentYear, 0, 1);
    const yearEnd = new Date(currentYear, 11, 31);

    const leaves = await Leave.find({
      employee: employeeId,
      status: 'approved',
      startDate: { $gte: yearStart, $lte: yearEnd }
    });

    // Calculate used leaves by type
    const usedLeaves = {
      annual: 0,
      sick: 0,
      casual: 0,
      maternity: 0,
      paternity: 0,
      emergency: 0,
      unpaid: 0
    };

    leaves.forEach(leave => {
      usedLeaves[leave.leaveType] += leave.totalDays;
    });

    // Get company leave policy
    const policy = employee.company.leavePolicy;

    const balance = {
      annual: {
        total: policy.annualLeave,
        used: usedLeaves.annual,
        remaining: policy.annualLeave - usedLeaves.annual
      },
      sick: {
        total: policy.sickLeave,
        used: usedLeaves.sick,
        remaining: policy.sickLeave - usedLeaves.sick
      },
      casual: {
        total: policy.casualLeave,
        used: usedLeaves.casual,
        remaining: policy.casualLeave - usedLeaves.casual
      },
      maternity: {
        total: policy.maternityLeave,
        used: usedLeaves.maternity,
        remaining: policy.maternityLeave - usedLeaves.maternity
      },
      paternity: {
        total: policy.paternityLeave,
        used: usedLeaves.paternity,
        remaining: policy.paternityLeave - usedLeaves.paternity
      }
    };

    res.status(200).json({
      employee: {
        id: employee._id,
        name: employee.name,
        employeeId: employee.employeeId
      },
      year: currentYear,
      balance
    });

  } catch (error) {
    res.status(500).json({ 
      message: 'Failed to get leave balance', 
      error: error.message 
    });
  }
});

// Get leave statistics (Admin only)
router.get('/stats/dashboard', authenticateToken, authorizeRoles('admin'), async (req, res) => {
  try {
    const currentMonth = new Date();
    const startOfMonth = new Date(currentMonth.getFullYear(), currentMonth.getMonth(), 1);
    const endOfMonth = new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 0);

    // Total leaves this month
    const thisMonthLeaves = await Leave.countDocuments({
      company: req.user.company._id,
      appliedDate: { $gte: startOfMonth, $lte: endOfMonth }
    });

    // Pending leaves
    const pendingLeaves = await Leave.countDocuments({
      company: req.user.company._id,
      status: 'pending'
    });

    // Total employees
    const totalEmployees = await User.countDocuments({
      company: req.user.company._id,
      role: 'employee',
      isActive: true
    });

    // Leave by type this month
    const leavesByType = await Leave.aggregate([
      {
        $match: {
          company: req.user.company._id,
          appliedDate: { $gte: startOfMonth, $lte: endOfMonth }
        }
      },
      {
        $group: {
          _id: '$leaveType',
          count: { $sum: 1 }
        }
      }
    ]);

    // Leave by status
    const leavesByStatus = await Leave.aggregate([
      {
        $match: {
          company: req.user.company._id
        }
      },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 }
        }
      }
    ]);

    res.status(200).json({
      thisMonthLeaves,
      pendingLeaves,
      totalEmployees,
      leavesByType,
      leavesByStatus
    });

  } catch (error) {
    res.status(500).json({ 
      message: 'Failed to get leave statistics', 
      error: error.message 
    });
  }
});

// Get leave policy (Admin only)
router.get('/policy', authenticateToken, authorizeRoles('admin'), async (req, res) => {
  try {
    const user = await User.findById(req.user._id).populate('company');
    if (!user || !user.company) {
      return res.status(404).json({ message: 'Company not found' });
    }

    const policy = user.company.leavePolicy || {
      annualLeave: 20,
      sickLeave: 10,
      casualLeave: 8,
      maternityLeave: 90,
      paternityLeave: 15
    };

    res.status(200).json({
      policy
    });

  } catch (error) {
    console.error('Leave policy error:', error);
    res.status(500).json({ 
      message: 'Failed to get leave policy', 
      error: error.message 
    });
  }
});

// Update leave policy (Admin only)
router.put('/policy', authenticateToken, authorizeRoles('admin'), async (req, res) => {
  try {
    const { policy } = req.body;
    
    const Company = require('../models/Company');
    const user = await User.findById(req.user._id);
    
    // Validate policy settings
    if (policy.maxConcurrentLeaves !== null && policy.maxConcurrentLeaves !== undefined) {
      if (policy.maxConcurrentLeaves < 0) {
        return res.status(400).json({ 
          message: 'Maximum concurrent leaves cannot be negative' 
        });
      }
    }
    
    const company = await Company.findByIdAndUpdate(
      user.company._id,
      { leavePolicy: policy },
      { new: true, runValidators: true }
    );

    res.status(200).json({
      message: 'Leave policy updated successfully',
      policy: company.leavePolicy
    });

  } catch (error) {
    console.error('Update leave policy error:', error);
    res.status(500).json({ 
      message: 'Failed to update leave policy', 
      error: error.message 
    });
  }
});

// Update employee leave allocation (Admin only)
router.put('/allocation/:employeeId', authenticateToken, authorizeRoles('admin'), async (req, res) => {
  try {
    const { employeeId } = req.params;
    const { allocations } = req.body;
    
    console.log('Allocation update request:', { employeeId, allocations, body: req.body });

    // Find the employee and verify they belong to the same company
    const employee = await User.findOne({
      _id: employeeId,
      company: req.user.company._id,
      role: 'employee'
    });

    if (!employee) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    // Update the employee's leave quota (the correct field name in the User model)
    const updatedEmployee = await User.findByIdAndUpdate(
      employeeId,
      { 
        $set: {
          'leaveQuota.annual': allocations.annual || 0,
          'leaveQuota.sick': allocations.sick || 0,
          'leaveQuota.casual': allocations.casual || 0,
          'leaveQuota.maternity': allocations.maternity || 0,
          'leaveQuota.paternity': allocations.paternity || 0,
          'leaveQuota.emergency': allocations.emergency || 0
        }
      },
      { new: true, runValidators: true }
    ).populate('company');

    res.status(200).json({
      message: 'Leave allocation updated successfully',
      employee: updatedEmployee
    });

  } catch (error) {
    console.error('Leave allocation update error:', error);
    res.status(500).json({ 
      message: 'Failed to update leave allocation', 
      error: error.message 
    });
  }
});

// Quick setup endpoint to enable overlap prevention (Admin only)
router.post('/policy/prevent-overlaps', authenticateToken, authorizeRoles('admin'), async (req, res) => {
  try {
    const Company = require('../models/Company');
    
    const company = await Company.findByIdAndUpdate(
      req.user.company._id,
      { 
        'leavePolicy.preventOverlappingLeaves': true
      },
      { new: true, runValidators: true }
    );

    res.status(200).json({
      message: 'Overlapping leave prevention enabled successfully',
      policy: company.leavePolicy
    });

  } catch (error) {
    console.error('Enable overlap prevention error:', error);
    res.status(500).json({ 
      message: 'Failed to enable overlap prevention', 
      error: error.message 
    });
  }
});

// Quick setup endpoint to set maximum concurrent leaves (Admin only)
router.post('/policy/max-concurrent/:maxCount', authenticateToken, authorizeRoles('admin'), async (req, res) => {
  try {
    const maxCount = parseInt(req.params.maxCount);
    
    if (maxCount < 0) {
      return res.status(400).json({ 
        message: 'Maximum concurrent leaves cannot be negative' 
      });
    }

    const Company = require('../models/Company');
    
    const company = await Company.findByIdAndUpdate(
      req.user.company._id,
      { 
        'leavePolicy.maxConcurrentLeaves': maxCount
      },
      { new: true, runValidators: true }
    );

    res.status(200).json({
      message: `Maximum concurrent leaves set to ${maxCount}`,
      policy: company.leavePolicy
    });

  } catch (error) {
    console.error('Set max concurrent leaves error:', error);
    res.status(500).json({ 
      message: 'Failed to set maximum concurrent leaves', 
      error: error.message 
    });
  }
});

module.exports = router;