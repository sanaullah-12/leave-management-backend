const mongoose = require('mongoose');

const leaveSchema = new mongoose.Schema({
  employee: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: [true, 'Leave must belong to an employee']
  },
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: [true, 'Leave must belong to a company']
  },
  leaveType: {
    type: String,
    required: [true, 'Please provide leave type'],
    enum: {
      values: ['annual', 'sick', 'casual', 'maternity', 'paternity', 'emergency', 'unpaid'],
      message: 'Leave type must be: annual, sick, casual, maternity, paternity, emergency, or unpaid'
    }
  },
  startDate: {
    type: Date,
    required: [true, 'Please provide start date']
  },
  endDate: {
    type: Date,
    required: [true, 'Please provide end date']
  },
  totalDays: {
    type: Number,
    required: false // Auto-calculated in pre-save hook
  },
  reason: {
    type: String,
    required: [true, 'Please provide reason for leave'],
    trim: true,
    maxlength: [500, 'Reason cannot exceed 500 characters']
  },
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected'],
    default: 'pending'
  },
  appliedDate: {
    type: Date,
    default: Date.now
  },
  reviewedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  reviewedDate: {
    type: Date
  },
  reviewComments: {
    type: String,
    trim: true,
    maxlength: [500, 'Review comments cannot exceed 500 characters']
  },
  /**
   * True when the system raised this leave rather than the employee.
   *
   * An unreported absence becomes annual leave after the office cutoff. Such a
   * record has to be distinguishable from one a person actually applied for:
   * it is reversible (an approved backdated work-from-home request revokes it
   * and returns the day), it is never counted as a request anybody reviewed,
   * and an employee reading their history deserves to know which is which.
   */
  isAutoMarked: {
    type: Boolean,
    default: false
  },
  /** What produced it, e.g. "unreported_absence". */
  autoMarkSource: {
    type: String,
    trim: true
  },
  autoMarkedAt: {
    type: Date
  },
  attachments: [{
    filename: String,
    originalName: String,
    mimetype: String,
    size: Number,
    path: String
  }]
}, {
  timestamps: true
});

// Calculate total days before saving
leaveSchema.pre('save', function(next) {
  if (this.startDate && this.endDate && !this.totalDays) {
    const timeDiff = this.endDate.getTime() - this.startDate.getTime();
    this.totalDays = Math.ceil(timeDiff / (1000 * 3600 * 24)) + 1;
  }
  
  // Ensure totalDays is at least 1
  if (!this.totalDays || this.totalDays < 1) {
    this.totalDays = 1;
  }
  
  next();
});

// Validate end date is after start date
leaveSchema.pre('save', function(next) {
  if (this.endDate < this.startDate) {
    next(new Error('End date must be after start date'));
  }
  next();
});

// Index for better query performance
leaveSchema.index({ employee: 1, status: 1 });
leaveSchema.index({ company: 1, status: 1 });

module.exports = mongoose.model('Leave', leaveSchema);