/**
 * NotificationTemplates.js
 * ------------------------
 * Every piece of user-facing notification copy, in one registry.
 *
 * One entry per event, one renderer per channel. Copy changes never require
 * touching a route, and a new channel is a new renderer key rather than a new
 * string scattered through business logic.
 *
 * Each renderer receives the normalised event payload and returns the shape
 * that channel needs:
 *   inApp    -> { title, message }
 *   whatsapp -> { body, approvedTemplate? }
 *
 * `approvedTemplate` is only consulted when the provider is configured to send
 * pre-approved templates (required by Meta outside the 24-hour customer
 * service window). Free-form `body` is used otherwise.
 */

const { NOTIFICATION_EVENTS } = require("./NotificationEvents");
const config = require("./config");

// -- Formatting helpers ----------------------------------------------------

const brand = () => config.branding.productName;

const LEAVE_TYPE_LABELS = {
  annual: "Annual Leave",
  sick: "Sick Leave",
  casual: "Casual Leave",
  maternity: "Maternity Leave",
  paternity: "Paternity Leave",
  emergency: "Emergency Leave",
  unpaid: "Unpaid Leave",
};

const VOICE_CATEGORY_LABELS = {
  workplace_issue: "Workplace Issue",
  complaint: "Complaint",
  suggestion: "Suggestion",
  hr_support: "HR Support Request",
  appreciation: "Appreciation",
  feedback: "Feedback",
};

const leaveTypeLabel = (type) =>
  LEAVE_TYPE_LABELS[type] || (type ? `${type} Leave` : "Leave");

const voiceCategoryLabel = (category) =>
  VOICE_CATEGORY_LABELS[category] || "Employee Voice";

const formatDate = (value) => {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
};

const formatDays = (days) => {
  const count = Number(days) || 0;
  return `${count} ${count === 1 ? "Day" : "Days"}`;
};

const formatRange = (start, end) => {
  const from = formatDate(start);
  const to = formatDate(end);
  if (!from && !to) return "";
  if (from === to || !to) return from;
  return `${from} to ${to}`;
};

const truncate = (text, max = 300) => {
  const value = String(text || "").trim();
  if (value.length <= max) return value;
  return `${value.slice(0, max - 3)}...`;
};

/**
 * Assembles a WhatsApp message body from sections, dropping empty ones so a
 * missing optional field never leaves a dangling label or a blank block.
 */
const compose = (headline, fields = [], footer = "") => {
  const blocks = [headline];

  for (const [label, value] of fields) {
    if (value === undefined || value === null || String(value).trim() === "") {
      continue;
    }
    blocks.push(`${label}:\n${value}`);
  }

  if (footer) blocks.push(footer);
  return blocks.join("\n\n");
};

const REVIEW_IN_APP = "Please review this request inside Nexora.";
const VIEW_IN_APP = "Open Nexora to view the details.";

// -- Template registry -----------------------------------------------------

const TEMPLATES = {
  // ---------------------------------------------------------------- Leave
  [NOTIFICATION_EVENTS.LEAVE_REQUESTED]: {
    inApp: ({ employeeName, leaveType, totalDays, startDate, endDate }) => ({
      title: "New Leave Request",
      message: `${employeeName} has submitted a ${leaveType} leave request for ${totalDays} day(s) from ${formatDate(
        startDate
      )} to ${formatDate(endDate)}.`,
    }),
    whatsapp: ({ employeeName, leaveType, totalDays, startDate, endDate, reason }) => ({
      body: compose(
        `📢 ${brand()}\n\nNew Leave Request`,
        [
          ["Employee", employeeName],
          ["Leave Type", leaveTypeLabel(leaveType)],
          ["Duration", formatDays(totalDays)],
          ["Dates", formatRange(startDate, endDate)],
          ["Reason", truncate(reason, 200)],
        ],
        REVIEW_IN_APP
      ),
      approvedTemplate: {
        name: "leave_request_submitted",
        params: [
          employeeName,
          leaveTypeLabel(leaveType),
          formatDays(totalDays),
          formatRange(startDate, endDate),
        ],
      },
    }),
  },

  [NOTIFICATION_EVENTS.LEAVE_APPROVED]: {
    inApp: ({ leaveType, totalDays, startDate, endDate }) => ({
      title: "Leave Request Approved",
      message: `Your ${leaveType} leave request for ${totalDays} day(s) from ${formatDate(
        startDate
      )} to ${formatDate(endDate)} has been approved.`,
    }),
    whatsapp: ({ leaveType, totalDays, startDate, endDate, reviewerName }) => ({
      body: compose(
        `✅ ${brand()}\n\nYour leave request has been approved.`,
        [
          ["Leave Type", leaveTypeLabel(leaveType)],
          ["Duration", formatDays(totalDays)],
          ["Dates", formatRange(startDate, endDate)],
          ["Approved By", reviewerName],
        ],
        "Thank you."
      ),
      approvedTemplate: {
        name: "leave_request_approved",
        params: [
          leaveTypeLabel(leaveType),
          formatDays(totalDays),
          formatRange(startDate, endDate),
        ],
      },
    }),
  },

  [NOTIFICATION_EVENTS.LEAVE_REJECTED]: {
    inApp: ({ leaveType, totalDays, startDate, endDate, reviewComments }) => ({
      title: "Leave Request Rejected",
      message: `Your ${leaveType} leave request for ${totalDays} day(s) from ${formatDate(
        startDate
      )} to ${formatDate(endDate)} has been rejected.${
        reviewComments ? ` Reason: ${reviewComments}` : ""
      }`,
    }),
    whatsapp: ({ leaveType, totalDays, startDate, endDate, reviewComments }) => ({
      body: compose(
        `❌ ${brand()}\n\nYour leave request has been rejected.`,
        [
          ["Leave Type", leaveTypeLabel(leaveType)],
          ["Duration", formatDays(totalDays)],
          ["Dates", formatRange(startDate, endDate)],
          ["Reason", truncate(reviewComments, 200)],
        ],
        "Please contact HR for additional information."
      ),
      approvedTemplate: {
        name: "leave_request_rejected",
        params: [leaveTypeLabel(leaveType), formatRange(startDate, endDate)],
      },
    }),
  },

  [NOTIFICATION_EVENTS.LEAVE_CANCELLED]: {
    inApp: ({ leaveType, startDate, endDate }) => ({
      title: "Leave Request Cancelled",
      message: `Your ${leaveType} leave request from ${formatDate(
        startDate
      )} to ${formatDate(endDate)} has been cancelled.`,
    }),
    whatsapp: ({ leaveType, totalDays, startDate, endDate, reviewComments }) => ({
      body: compose(
        `⚠️ ${brand()}\n\nYour leave request has been cancelled.`,
        [
          ["Leave Type", leaveTypeLabel(leaveType)],
          ["Duration", formatDays(totalDays)],
          ["Dates", formatRange(startDate, endDate)],
          ["Note", truncate(reviewComments, 200)],
        ],
        "Please contact HR for additional information."
      ),
      approvedTemplate: {
        name: "leave_request_cancelled",
        params: [leaveTypeLabel(leaveType), formatRange(startDate, endDate)],
      },
    }),
  },

  // -------------------------------------------------------- Employee Voice
  [NOTIFICATION_EVENTS.VOICE_SUBMITTED]: {
    inApp: ({ category, submitterName, voiceTitle }) => ({
      title: `New ${voiceCategoryLabel(category)}`,
      message: `${submitterName} submitted a ${voiceCategoryLabel(
        category
      ).toLowerCase()}: "${voiceTitle}".`,
    }),
    whatsapp: ({ category, submitterName, voiceTitle }) => ({
      body: compose(
        `📢 ${brand()}\n\nNew ${voiceCategoryLabel(category)}`,
        [
          ["Submitted By", submitterName],
          ["Subject", truncate(voiceTitle, 120)],
        ],
        REVIEW_IN_APP
      ),
      approvedTemplate: {
        name: "voice_submitted",
        params: [submitterName, voiceCategoryLabel(category), truncate(voiceTitle, 120)],
      },
    }),
  },

  [NOTIFICATION_EVENTS.VOICE_REPLIED]: {
    inApp: ({ fromAdmin, senderName, voiceTitle }) => ({
      title: fromAdmin ? "HR replied to your submission" : "New reply on a submission",
      message: `${fromAdmin ? "HR" : senderName} replied to "${voiceTitle}".`,
    }),
    whatsapp: ({ fromAdmin, senderName, voiceTitle }) => ({
      body: compose(
        `💬 ${brand()}\n\n${
          fromAdmin ? "HR replied to your submission." : "New reply on a submission."
        }`,
        [
          ["Subject", truncate(voiceTitle, 120)],
          ["From", fromAdmin ? "HR" : senderName],
        ],
        VIEW_IN_APP
      ),
      approvedTemplate: {
        name: "voice_replied",
        params: [truncate(voiceTitle, 120)],
      },
    }),
  },

  [NOTIFICATION_EVENTS.VOICE_STATUS_CHANGED]: {
    inApp: ({ voiceTitle, statusLabel }) => ({
      title: "Submission status updated",
      message: `Your submission "${voiceTitle}" is now ${statusLabel}.`,
    }),
    whatsapp: ({ voiceTitle, statusLabel }) => ({
      body: compose(
        `🔄 ${brand()}\n\nYour submission status has been updated.`,
        [
          ["Subject", truncate(voiceTitle, 120)],
          ["Status", statusLabel],
        ],
        VIEW_IN_APP
      ),
      approvedTemplate: {
        name: "voice_status_changed",
        params: [truncate(voiceTitle, 120), statusLabel],
      },
    }),
  },

  // --------------------------------------------------------- Announcements
  [NOTIFICATION_EVENTS.ANNOUNCEMENT_PUBLISHED]: {
    inApp: ({ announcementTitle, preview, authorName }) => ({
      title: announcementTitle,
      message: preview || `${authorName} posted a new announcement.`,
    }),
    whatsapp: ({ announcementTitle, preview, authorName }) => ({
      body: compose(
        `📣 ${brand()}\n\nNew Announcement`,
        [
          ["Title", truncate(announcementTitle, 120)],
          ["Posted By", authorName],
          ["Details", truncate(preview, 300)],
        ],
        VIEW_IN_APP
      ),
      approvedTemplate: {
        name: "announcement_published",
        params: [truncate(announcementTitle, 120), authorName],
      },
    }),
  },

  // ------------------------------------------------------- Future modules
  // Wired ahead of the emitting code so those modules only have to dispatch.
  [NOTIFICATION_EVENTS.EMPLOYEE_CREATED]: {
    inApp: ({ employeeName, department }) => ({
      title: "New Employee Added",
      message: `${employeeName} has been added to ${department || "the company"}.`,
    }),
    whatsapp: ({ employeeName, department, position }) => ({
      body: compose(
        `👤 ${brand()}\n\nNew Employee Added`,
        [
          ["Employee", employeeName],
          ["Department", department],
          ["Position", position],
        ],
        VIEW_IN_APP
      ),
      approvedTemplate: {
        name: "employee_created",
        params: [employeeName, department || "-"],
      },
    }),
  },

  [NOTIFICATION_EVENTS.DOCUMENT_APPROVAL_REQUESTED]: {
    inApp: ({ documentTitle, requesterName }) => ({
      title: "Document Approval Requested",
      message: `${requesterName} requested approval for "${documentTitle}".`,
    }),
    whatsapp: ({ documentTitle, requesterName, documentType }) => ({
      body: compose(
        `📄 ${brand()}\n\nDocument Approval Request`,
        [
          ["Document", truncate(documentTitle, 120)],
          ["Type", documentType],
          ["Requested By", requesterName],
        ],
        REVIEW_IN_APP
      ),
      approvedTemplate: {
        name: "document_approval_requested",
        params: [truncate(documentTitle, 120), requesterName],
      },
    }),
  },

  [NOTIFICATION_EVENTS.DOCUMENT_APPROVED]: {
    inApp: ({ documentTitle }) => ({
      title: "Document Approved",
      message: `Your document "${documentTitle}" has been approved.`,
    }),
    whatsapp: ({ documentTitle, reviewerName }) => ({
      body: compose(
        `✅ ${brand()}\n\nYour document has been approved.`,
        [
          ["Document", truncate(documentTitle, 120)],
          ["Approved By", reviewerName],
        ],
        VIEW_IN_APP
      ),
      approvedTemplate: {
        name: "document_approved",
        params: [truncate(documentTitle, 120)],
      },
    }),
  },

  [NOTIFICATION_EVENTS.PAYROLL_GENERATED]: {
    inApp: ({ period }) => ({
      title: "Payslip Available",
      message: `Your payslip for ${period} is now available.`,
    }),
    whatsapp: ({ period, netPay, currency }) => ({
      body: compose(
        `💰 ${brand()}\n\nYour payslip is now available.`,
        [
          ["Period", period],
          ["Net Pay", netPay ? `${currency || ""} ${netPay}`.trim() : ""],
        ],
        VIEW_IN_APP
      ),
      approvedTemplate: {
        name: "payroll_generated",
        params: [period],
      },
    }),
  },
};

/**
 * Renders one event for one channel.
 * Returns null when the event has no copy for that channel, which the channel
 * treats as "nothing to send" rather than an error - that is how an event can
 * be in-app only, or WhatsApp only, without any conditional in business code.
 */
const render = (event, channel, payload = {}) => {
  const template = TEMPLATES[event];
  if (!template || typeof template[channel] !== "function") return null;

  try {
    return template[channel](payload);
  } catch (error) {
    // A template must never take down a dispatch. Returning null degrades to
    // "this channel sends nothing" while the logger records the cause.
    require("./NotificationLogger").error("Template render failed", {
      event,
      channel,
      error: error.message,
    });
    return null;
  }
};

const hasTemplate = (event, channel) =>
  Boolean(TEMPLATES[event] && typeof TEMPLATES[event][channel] === "function");

module.exports = {
  render,
  hasTemplate,
  // Exported for reuse by callers that build their own copy (the compatibility
  // layer in utils/notifications.js) and by tests.
  helpers: {
    leaveTypeLabel,
    voiceCategoryLabel,
    formatDate,
    formatDays,
    formatRange,
    truncate,
    compose,
  },
};
