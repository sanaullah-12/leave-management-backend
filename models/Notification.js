const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
  recipient: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: [true, 'Notification must have a recipient']
  },
  sender: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: [true, 'Notification must belong to a company']
  },
  type: {
    type: String,
    enum: [
      'leave_request',
      'leave_approved',
      'leave_rejected',
      'voice_submitted',
      'voice_reply',
      'voice_status',
      'announcement',
      'wfh_request',
      'wfh_approved',
      'wfh_rejected',
      'leave_auto_marked',
      'leave_auto_reversed',
      'attendance_late',
      'app_update'
    ],
    required: [true, 'Notification type is required']
  },
  title: {
    type: String,
    required: [true, 'Notification title is required'],
    trim: true
  },
  message: {
    type: String,
    required: [true, 'Notification message is required'],
    trim: true
  },
  leaveId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Leave'
  },
  // Polymorphic reference for the Employee Voice module.
  voiceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'EmployeeVoice'
  },
  // Polymorphic reference for the Announcements module.
  announcementId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Announcement'
  },
  // Polymorphic reference for the Work From Home module.
  wfhId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'WorkFromHome'
  },
  /**
   * Optional idempotency key for notifications that must exist at most once.
   *
   * A late arrival is derived from attendance records on every sync, so the
   * same punch is seen again on the next pass. The key ("late:<user>:<date>")
   * lets a caller ask "has this already been sent?" and lets the unique index
   * settle the race if two syncs overlap. Sparse: every existing notification,
   * and every event that legitimately repeats, simply has no key.
   */
  dedupeKey: {
    type: String,
    default: undefined
  },
  read: {
    type: Boolean,
    default: false
  },
  readAt: {
    type: Date
  }
}, {
  timestamps: true
});

// Index for efficient queries
notificationSchema.index({ recipient: 1, read: 1, createdAt: -1 });
notificationSchema.index({ company: 1, createdAt: -1 });

// Partial rather than sparse: it must constrain only the documents that carry a
// key, and leave every keyless notification entirely outside the index.
notificationSchema.index(
  { dedupeKey: 1 },
  {
    unique: true,
    partialFilterExpression: { dedupeKey: { $type: 'string' } }
  }
);

module.exports = mongoose.model('Notification', notificationSchema);