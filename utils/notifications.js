const Notification = require('../models/Notification');
const SocketService = require('../socket/socketService');

const createNotification = async ({
  recipient,
  sender,
  company,
  type,
  title,
  message,
  leaveId = null,
  voiceId = null,
  announcementId = null
}) => {
  try {
    const notification = new Notification({
      recipient,
      sender,
      company,
      type,
      title,
      message,
      leaveId,
      voiceId,
      announcementId
    });

    await notification.save();

    // Real-time: push the notification to the recipient's room instantly.
    // Fail-safe — a socket hiccup must never break notification creation.
    SocketService.toUser(recipient, SocketService.events.NOTIFICATION_NEW, {
      _id: notification._id,
      type: notification.type,
      title: notification.title,
      message: notification.message,
      leaveId: notification.leaveId,
      voiceId: notification.voiceId,
      announcementId: notification.announcementId,
      read: false,
      createdAt: notification.createdAt,
    });

    return notification;
  } catch (error) {
    console.error('Error creating notification:', error);
    throw error;
  }
};

// ── Announcements ─────────────────────────────────────────────────────────
// One recipient is told a new company announcement was posted.
const notifyAnnouncement = async (announcement, recipientId, sender) => {
  const preview =
    announcement.body && announcement.body.length > 120
      ? `${announcement.body.slice(0, 120)}…`
      : announcement.body || '';
  return await createNotification({
    recipient: recipientId,
    sender: sender && (sender._id || sender),
    company: announcement.company,
    type: 'announcement',
    title: `📣 ${announcement.title}`,
    message: preview || `${announcement.authorName} posted a new announcement.`,
    announcementId: announcement._id,
  });
};

// ── Employee Voice notifications ──────────────────────────────────────────
const CATEGORY_LABELS = {
  workplace_issue: 'Workplace Issue',
  complaint: 'Complaint',
  suggestion: 'Suggestion',
  hr_support: 'HR Support Request',
  appreciation: 'Appreciation',
  feedback: 'Feedback'
};

// Admin is told an employee raised a new Voice.
const notifyVoiceSubmission = async (voice, admin) => {
  const label = CATEGORY_LABELS[voice.category] || 'Employee Voice';
  const who = voice.isAnonymous
    ? 'An anonymous employee'
    : (voice.employee && voice.employee.name) || 'An employee';

  return await createNotification({
    recipient: admin._id,
    // Preserve anonymity: never attach the sender for anonymous submissions.
    sender: voice.isAnonymous
      ? undefined
      : voice.employee && (voice.employee._id || voice.employee),
    company: voice.company,
    type: 'voice_submitted',
    title: `New ${label}`,
    message: `${who} submitted a ${label.toLowerCase()}: "${voice.title}".`,
    voiceId: voice._id
  });
};

// A reply was posted — notify the other party (employee ⇄ admin).
const notifyVoiceReply = async (voice, recipientId, sender) => {
  const senderName = (sender && sender.name) || 'Someone';
  const isFromAdmin = sender && sender.role === 'admin';

  return await createNotification({
    recipient: recipientId,
    sender: sender && sender._id,
    company: voice.company,
    type: 'voice_reply',
    title: isFromAdmin ? 'HR replied to your submission' : 'New reply on a submission',
    message: `${isFromAdmin ? 'HR' : senderName} replied to "${voice.title}".`,
    voiceId: voice._id
  });
};

// The status of a Voice changed — notify the submitting employee.
const notifyVoiceStatus = async (voice, statusLabel, sender) => {
  return await createNotification({
    recipient: voice.employee._id || voice.employee,
    sender: sender && sender._id,
    company: voice.company,
    type: 'voice_status',
    title: 'Submission status updated',
    message: `Your submission "${voice.title}" is now ${statusLabel}.`,
    voiceId: voice._id
  });
};

const notifyLeaveRequest = async (leave, admin) => {
  const employeeName = typeof leave.employee === 'object' ? leave.employee.name : 'Employee';
  
  return await createNotification({
    recipient: admin._id,
    sender: leave.employee._id || leave.employee,
    company: leave.company,
    type: 'leave_request',
    title: 'New Leave Request',
    message: `${employeeName} has submitted a ${leave.leaveType} leave request for ${leave.totalDays} day(s) from ${new Date(leave.startDate).toLocaleDateString()} to ${new Date(leave.endDate).toLocaleDateString()}.`,
    leaveId: leave._id
  });
};

const notifyLeaveApproval = async (leave, employee) => {
  return await createNotification({
    recipient: employee._id,
    sender: leave.reviewedBy,
    company: leave.company,
    type: 'leave_approved',
    title: 'Leave Request Approved',
    message: `Your ${leave.leaveType} leave request for ${leave.totalDays} day(s) from ${new Date(leave.startDate).toLocaleDateString()} to ${new Date(leave.endDate).toLocaleDateString()} has been approved.`,
    leaveId: leave._id
  });
};

const notifyLeaveRejection = async (leave, employee, rejectionReason = '') => {
  const reasonText = rejectionReason ? ` Reason: ${rejectionReason}` : '';
  
  return await createNotification({
    recipient: employee._id,
    sender: leave.reviewedBy,
    company: leave.company,
    type: 'leave_rejected',
    title: 'Leave Request Rejected',
    message: `Your ${leave.leaveType} leave request for ${leave.totalDays} day(s) from ${new Date(leave.startDate).toLocaleDateString()} to ${new Date(leave.endDate).toLocaleDateString()} has been rejected.${reasonText}`,
    leaveId: leave._id
  });
};

module.exports = {
  createNotification,
  notifyLeaveRequest,
  notifyLeaveApproval,
  notifyLeaveRejection,
  notifyVoiceSubmission,
  notifyVoiceReply,
  notifyVoiceStatus,
  notifyAnnouncement
};