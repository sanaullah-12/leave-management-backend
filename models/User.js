const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Please provide name'],
    trim: true,
    maxlength: [50, 'Name cannot exceed 50 characters']
  },
  email: {
    type: String,
    required: [true, 'Please provide email'],
    unique: true,
    lowercase: true,
    match: [
      /^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/,
      'Please provide valid email'
    ]
  },
  password: {
    type: String,
    required: function() {
      // Password is required only if user status is 'active' or user is not invited
      return this.status === 'active' || !this.invitationToken;
    },
    minlength: [6, 'Password must be at least 6 characters'],
    select: false
  },
  role: {
    type: String,
    enum: ['admin', 'employee'],
    default: 'employee'
  },
  employeeId: {
    type: String,
    unique: true,
    trim: true
  },
  department: {
    type: String,
    required: [true, 'Please provide department'],
    trim: true
  },
  position: {
    type: String,
    required: [true, 'Please provide position'],
    trim: true
  },
  joinDate: {
    type: Date,
    required: [true, 'Please provide join date']
  },
  phone: {
    type: String,
    trim: true
  },
  profilePicture: {
    type: String,
    default: null // URL or base64 string for profile picture
  },
  status: {
    type: String,
    enum: ['pending', 'active', 'inactive'],
    default: 'pending'
  },
  isActive: {
    type: Boolean,
    default: true
  },
  invitationToken: {
    type: String,
    select: false
  },
  invitationExpires: {
    type: Date,
    select: false
  },
  invitedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  passwordResetToken: {
    type: String,
    select: false
  },
  passwordResetExpires: {
    type: Date,
    select: false
  },
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: [true, 'User must belong to a company']
  },
  leaveQuota: {
    annual: { type: Number, default: 20 },
    sick: { type: Number, default: 10 },
    casual: { type: Number, default: 8 },
    maternity: { type: Number, default: 90 },
    paternity: { type: Number, default: 15 },
    emergency: { type: Number, default: 5 }
  },
  leaveYear: {
    type: Number,
    default: function() { return new Date().getFullYear(); }
  }
}, {
  timestamps: true
});

// Pre-save hook for password hashing and employee ID generation
userSchema.pre('save', async function(next) {
  // Hash password if modified and password exists
  if (this.isModified('password') && this.password) {
    const salt = await bcrypt.genSalt(12);
    this.password = await bcrypt.hash(this.password, salt);
  }
  
  // Generate employee ID if not provided
  if (!this.employeeId && this.company) {
    const count = await this.constructor.countDocuments({ company: this.company });
    this.employeeId = `EMP${String(count + 1).padStart(4, '0')}`;
  }
  
  next();
});

// Compare password method
userSchema.methods.comparePassword = async function(candidatePassword) {
  if (!this.password) {
    return false;
  }
  return await bcrypt.compare(candidatePassword, this.password);
};

// Generate invitation token
userSchema.methods.generateInvitationToken = function() {
  const crypto = require('crypto');
  const token = crypto.randomBytes(32).toString('hex');
  
  this.invitationToken = crypto.createHash('sha256').update(token).digest('hex');
  this.invitationExpires = Date.now() + 7 * 24 * 60 * 60 * 1000; // 7 days
  
  return token;
};

// Generate password reset token
userSchema.methods.generatePasswordResetToken = function() {
  const crypto = require('crypto');
  const resetToken = crypto.randomBytes(32).toString('hex');
  
  this.passwordResetToken = crypto.createHash('sha256').update(resetToken).digest('hex');
  this.passwordResetExpires = Date.now() + 15 * 60 * 1000; // 15 minutes
  
  return resetToken;
};

// Calculate leave balance for a specific leave type
userSchema.methods.getLeaveBalance = async function(leaveType) {
  const Leave = require('./Leave');
  const currentYear = new Date().getFullYear();
  
  // Get total leaves used for this type in current year
  const usedLeaves = await Leave.aggregate([
    {
      $match: {
        employee: this._id,
        leaveType: leaveType,
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
  const quota = this.leaveQuota[leaveType] || 0;
  
  return {
    total: quota,
    used: usedDays,
    remaining: Math.max(0, quota - usedDays)
  };
};

// Get all leave balances
userSchema.methods.getAllLeaveBalances = async function() {
  const leaveTypes = ['annual', 'sick', 'casual'];
  const balances = {};
  
  for (const type of leaveTypes) {
    balances[type] = await this.getLeaveBalance(type);
  }
  
  return balances;
};

module.exports = mongoose.model('User', userSchema);