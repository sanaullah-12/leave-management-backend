/**
 * utils/notifications.js
 * ----------------------
 * The notification helpers business code has always called, now backed by the
 * multi-channel notification layer in ../notifications.
 *
 * Every function keeps its original signature, its original return value and
 * its original in-app copy. Routes did not change, and the in-app + Socket.IO
 * behaviour they depend on is byte-for-byte what it was: the same Notification
 * document, the same NOTIFICATION_NEW payload, the same errors thrown on
 * failure so existing try/catch blocks still report what they always did.
 *
 * What is new is that each helper now also dispatches to every other enabled
 * channel - today, WhatsApp - through NotificationService. That work is
 * queued, so it adds no latency here, and it is settled independently, so it
 * cannot affect the in-app result.
 *
 * New code should prefer NotificationService.dispatch() directly and let the
 * template registry produce the copy. These wrappers exist so that adopting
 * WhatsApp required no change to a single existing route.
 */

const {
  NotificationService,
  NOTIFICATION_EVENTS,
  RecipientResolver,
} = require("../notifications");

/**
 * Loads the extra fields the WhatsApp channel needs (phone, preferences) for a
 * user these helpers were handed as a bare id.
 *
 * Falls back to a minimal recipient when the resolver filters the user out -
 * they may be `pending` or deactivated, and those users received in-app
 * notifications before, so they still must. Without a phone number the
 * WhatsApp channel skips them on its own, which is the correct outcome anyway.
 */
const targetUser = async (userId) => {
  try {
    const [resolved] = await RecipientResolver.resolveUser(userId);
    if (resolved) return resolved;
  } catch (error) {
    console.error("Recipient lookup failed, using id only:", error.message);
  }
  return { _id: userId, preferences: {} };
};

/**
 * Runs a dispatch and returns the in-app notification, preserving the original
 * contract: resolve with the Notification document, or throw if creating it
 * failed. WhatsApp outcomes never influence either.
 */
const dispatchAndUnwrap = async ({ userId, ...options }) => {
  const result = await NotificationService.dispatch({
    ...options,
    recipients: [await targetUser(userId)],
  });

  if (result.socket.failed.length > 0) {
    // The in-app notification is the one the caller is waiting on. Re-throwing
    // keeps the existing "Failed to send in-app notification" logging intact.
    throw result.socket.failed[0].error;
  }

  return result.socket.sent[0] || null;
};

/**
 * Creates a single in-app notification with explicit copy.
 *
 * Retained for callers that compose their own title and message. It routes
 * through the notification layer, so such a notification also reaches WhatsApp
 * when the event maps to a WhatsApp template.
 */
const createNotification = async ({
  recipient,
  sender,
  company,
  type,
  title,
  message,
  leaveId = null,
  voiceId = null,
  announcementId = null,
  wfhId = null,
  event = null,
  payload = {},
}) => {
  try {
    const result = await NotificationService.dispatch({
      // Ad-hoc callers have no domain event; ANNOUNCEMENT_PUBLISHED is the
      // generic "something was posted" event and only its in-app override is
      // used when no template payload is supplied.
      event: event || NOTIFICATION_EVENTS.ANNOUNCEMENT_PUBLISHED,
      payload,
      companyId: company,
      senderId: sender,
      // Only look the recipient up when another channel could use the extra
      // fields; an in-app-only call needs nothing beyond the id.
      recipients: [
        event ? await targetUser(recipient) : { _id: recipient, preferences: {} },
      ],
      refs: { leaveId, voiceId, announcementId, wfhId },
      inApp: { title, message },
      inAppType: type,
      // Without a payload there is nothing to render a WhatsApp message from,
      // so ad-hoc calls stay in-app only rather than sending a half-filled one.
      channels: event ? undefined : ["socket"],
    });

    if (result.socket.failed.length > 0) throw result.socket.failed[0].error;
    return result.socket.sent[0] || null;
  } catch (error) {
    console.error("Error creating notification:", error);
    throw error;
  }
};

// -- Announcements ---------------------------------------------------------
// One recipient is told a new company announcement was posted.
const notifyAnnouncement = async (announcement, recipientId, sender) => {
  const preview =
    announcement.body && announcement.body.length > 120
      ? `${announcement.body.slice(0, 120)}...`
      : announcement.body || "";

  return dispatchAndUnwrap({
    event: NOTIFICATION_EVENTS.ANNOUNCEMENT_PUBLISHED,
    companyId: announcement.company,
    senderId: sender && (sender._id || sender),
    userId: recipientId,
    refs: { announcementId: announcement._id },
    payload: {
      announcementTitle: announcement.title,
      preview,
      authorName: announcement.authorName,
    },
    inApp: {
      title: ` ${announcement.title}`,
      message: preview || `${announcement.authorName} posted a new announcement.`,
    },
  });
};

// -- Employee Voice notifications ------------------------------------------
const CATEGORY_LABELS = {
  workplace_issue: "Workplace Issue",
  complaint: "Complaint",
  suggestion: "Suggestion",
  hr_support: "HR Support Request",
  appreciation: "Appreciation",
  feedback: "Feedback",
};

// Admin is told an employee raised a new Voice.
const notifyVoiceSubmission = async (voice, admin) => {
  const label = CATEGORY_LABELS[voice.category] || "Employee Voice";
  const who = voice.isAnonymous
    ? "An anonymous employee"
    : (voice.employee && voice.employee.name) || "An employee";

  return dispatchAndUnwrap({
    event: NOTIFICATION_EVENTS.VOICE_SUBMITTED,
    companyId: voice.company,
    // Preserve anonymity: never attach the sender for anonymous submissions.
    senderId: voice.isAnonymous
      ? undefined
      : voice.employee && (voice.employee._id || voice.employee),
    userId: admin._id,
    refs: { voiceId: voice._id },
    payload: {
      category: voice.category,
      submitterName: who,
      voiceTitle: voice.title,
    },
    inApp: {
      title: `New ${label}`,
      message: `${who} submitted a ${label.toLowerCase()}: "${voice.title}".`,
    },
  });
};

// A reply was posted - notify the other party (employee <-> admin).
const notifyVoiceReply = async (voice, recipientId, sender) => {
  const senderName = (sender && sender.name) || "Someone";
  const isFromAdmin = sender && sender.role === "admin";

  return dispatchAndUnwrap({
    event: NOTIFICATION_EVENTS.VOICE_REPLIED,
    companyId: voice.company,
    senderId: sender && sender._id,
    userId: recipientId,
    refs: { voiceId: voice._id },
    payload: {
      fromAdmin: isFromAdmin,
      senderName,
      voiceTitle: voice.title,
    },
    inApp: {
      title: isFromAdmin
        ? "HR replied to your submission"
        : "New reply on a submission",
      message: `${isFromAdmin ? "HR" : senderName} replied to "${voice.title}".`,
    },
  });
};

// The status of a Voice changed - notify the submitting employee.
const notifyVoiceStatus = async (voice, statusLabel, sender) => {
  return dispatchAndUnwrap({
    event: NOTIFICATION_EVENTS.VOICE_STATUS_CHANGED,
    companyId: voice.company,
    senderId: sender && sender._id,
    userId: voice.employee._id || voice.employee,
    refs: { voiceId: voice._id },
    payload: {
      voiceTitle: voice.title,
      statusLabel,
    },
    inApp: {
      title: "Submission status updated",
      message: `Your submission "${voice.title}" is now ${statusLabel}.`,
    },
  });
};

// -- Leave notifications ---------------------------------------------------
const notifyLeaveRequest = async (leave, admin) => {
  const employeeName =
    typeof leave.employee === "object" ? leave.employee.name : "Employee";

  return dispatchAndUnwrap({
    event: NOTIFICATION_EVENTS.LEAVE_REQUESTED,
    companyId: leave.company,
    senderId: leave.employee._id || leave.employee,
    userId: admin._id,
    refs: { leaveId: leave._id },
    payload: {
      employeeName,
      leaveType: leave.leaveType,
      totalDays: leave.totalDays,
      startDate: leave.startDate,
      endDate: leave.endDate,
      reason: leave.reason,
    },
    inApp: {
      title: "New Leave Request",
      message: `${employeeName} has submitted a ${leave.leaveType} leave request for ${
        leave.totalDays
      } day(s) from ${new Date(
        leave.startDate
      ).toLocaleDateString()} to ${new Date(
        leave.endDate
      ).toLocaleDateString()}.`,
    },
  });
};

const notifyLeaveApproval = async (leave, employee) => {
  return dispatchAndUnwrap({
    event: NOTIFICATION_EVENTS.LEAVE_APPROVED,
    companyId: leave.company,
    senderId: leave.reviewedBy,
    userId: employee._id,
    refs: { leaveId: leave._id },
    payload: {
      leaveType: leave.leaveType,
      totalDays: leave.totalDays,
      startDate: leave.startDate,
      endDate: leave.endDate,
      reviewerName:
        leave.reviewedBy && leave.reviewedBy.name ? leave.reviewedBy.name : "",
    },
    inApp: {
      title: "Leave Request Approved",
      message: `Your ${leave.leaveType} leave request for ${
        leave.totalDays
      } day(s) from ${new Date(
        leave.startDate
      ).toLocaleDateString()} to ${new Date(
        leave.endDate
      ).toLocaleDateString()} has been approved.`,
    },
  });
};

const notifyLeaveRejection = async (leave, employee, rejectionReason = "") => {
  const reasonText = rejectionReason ? ` Reason: ${rejectionReason}` : "";

  return dispatchAndUnwrap({
    event: NOTIFICATION_EVENTS.LEAVE_REJECTED,
    companyId: leave.company,
    senderId: leave.reviewedBy,
    userId: employee._id,
    refs: { leaveId: leave._id },
    payload: {
      leaveType: leave.leaveType,
      totalDays: leave.totalDays,
      startDate: leave.startDate,
      endDate: leave.endDate,
      reviewComments: rejectionReason,
    },
    inApp: {
      title: "Leave Request Rejected",
      message: `Your ${leave.leaveType} leave request for ${
        leave.totalDays
      } day(s) from ${new Date(
        leave.startDate
      ).toLocaleDateString()} to ${new Date(
        leave.endDate
      ).toLocaleDateString()} has been rejected.${reasonText}`,
    },
  });
};

// -- Work From Home --------------------------------------------------------
// Same three-step shape as leave: admins hear about a request, the employee
// hears the decision. The copy states that WFH does not touch the leave
// balance, because that is the question it otherwise prompts.

const notifyWfhRequest = async (request, admin) => {
  const employeeName =
    typeof request.employee === "object" ? request.employee.name : "Employee";

  return dispatchAndUnwrap({
    event: NOTIFICATION_EVENTS.WFH_REQUESTED,
    companyId: request.company,
    senderId: request.employee._id || request.employee,
    userId: admin._id,
    refs: { wfhId: request._id },
    payload: {
      employeeName,
      totalDays: request.totalDays,
      startDate: request.startDate,
      endDate: request.endDate,
      reason: request.reason,
      isBackdated: request.isBackdated,
    },
    inApp: {
      title: request.isBackdated
        ? "Backdated Work From Home Request"
        : "New Work From Home Request",
      message: `${employeeName} has ${
        request.isBackdated ? "recorded" : "requested"
      } work from home for ${request.totalDays} day(s) from ${new Date(
        request.startDate
      ).toLocaleDateString()} to ${new Date(
        request.endDate
      ).toLocaleDateString()}.${
        request.isBackdated
          ? " These days have already passed and are currently recorded as absent."
          : ""
      }`,
    },
  });
};

const notifyWfhApproval = async (request, employee) => {
  return dispatchAndUnwrap({
    event: NOTIFICATION_EVENTS.WFH_APPROVED,
    companyId: request.company,
    senderId: request.reviewedBy,
    userId: employee._id,
    refs: { wfhId: request._id },
    payload: {
      totalDays: request.totalDays,
      startDate: request.startDate,
      endDate: request.endDate,
      reviewerName:
        request.reviewedBy && request.reviewedBy.name
          ? request.reviewedBy.name
          : "",
    },
    inApp: {
      title: "Work From Home Approved",
      message: `Your request to work from home for ${
        request.totalDays
      } day(s) from ${new Date(
        request.startDate
      ).toLocaleDateString()} to ${new Date(
        request.endDate
      ).toLocaleDateString()} has been approved. These days count as working days and do not use your leave balance.`,
    },
  });
};

const notifyWfhRejection = async (request, employee, rejectionReason = "") => {
  const reasonText = rejectionReason ? ` Reason: ${rejectionReason}` : "";

  return dispatchAndUnwrap({
    event: NOTIFICATION_EVENTS.WFH_REJECTED,
    companyId: request.company,
    senderId: request.reviewedBy,
    userId: employee._id,
    refs: { wfhId: request._id },
    payload: {
      totalDays: request.totalDays,
      startDate: request.startDate,
      endDate: request.endDate,
      reviewComments: rejectionReason,
    },
    inApp: {
      title: "Work From Home Rejected",
      message: `Your request to work from home for ${
        request.totalDays
      } day(s) from ${new Date(
        request.startDate
      ).toLocaleDateString()} to ${new Date(
        request.endDate
      ).toLocaleDateString()} has been rejected.${reasonText}`,
    },
  });
};

module.exports = {
  createNotification,
  notifyWfhRequest,
  notifyWfhApproval,
  notifyWfhRejection,
  notifyLeaveRequest,
  notifyLeaveApproval,
  notifyLeaveRejection,
  notifyVoiceSubmission,
  notifyVoiceReply,
  notifyVoiceStatus,
  notifyAnnouncement,
};
