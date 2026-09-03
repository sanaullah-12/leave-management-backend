/**
 * NotificationEvents.js
 * ---------------------
 * The contract between business code and the notification layer.
 *
 * Business code (routes, controllers, services) never names a channel, a
 * template or a provider. It states what happened - `LEAVE_REQUESTED` - and
 * hands over the data. Everything downstream is the notification layer's job.
 *
 * Adding a channel (SMS, Slack, push) therefore never touches a route: it is a
 * new entry in notifications/channels/ plus a new renderer per event.
 */

const NOTIFICATION_EVENTS = Object.freeze({
  // -- Leave -------------------------------------------------------------
  LEAVE_REQUESTED: "leave.requested",
  LEAVE_APPROVED: "leave.approved",
  LEAVE_REJECTED: "leave.rejected",
  LEAVE_CANCELLED: "leave.cancelled",

  // -- Unreported absence ------------------------------------------------
  LEAVE_AUTO_MARKED: "leave.auto_marked",
  LEAVE_AUTO_REVERSED: "leave.auto_reversed",

  // -- Work From Home ----------------------------------------------------
  WFH_REQUESTED: "wfh.requested",
  WFH_APPROVED: "wfh.approved",
  WFH_REJECTED: "wfh.rejected",

  // -- Employee Voice ----------------------------------------------------
  VOICE_SUBMITTED: "voice.submitted",
  VOICE_REPLIED: "voice.replied",
  VOICE_STATUS_CHANGED: "voice.status_changed",

  // -- Announcements -----------------------------------------------------
  ANNOUNCEMENT_PUBLISHED: "announcement.published",

  // -- Reserved for modules that will emit once they land. Declaring them
  //    here keeps the vocabulary in one place; a template can be added
  //    without touching this file again.
  EMPLOYEE_CREATED: "employee.created",
  DOCUMENT_APPROVAL_REQUESTED: "document.approval_requested",
  DOCUMENT_APPROVED: "document.approved",
  PAYROLL_GENERATED: "payroll.generated",
});

/**
 * Which direction an event travels. The recipient resolver uses this to decide
 * whether to fan out to the back office or to target one employee, so a caller
 * never has to look up who should hear about something.
 */
const AUDIENCE = Object.freeze({
  /** Every admin/HR user in the company. */
  COMPANY_ADMINS: "company_admins",
  /** One named user. */
  USER: "user",
  /** Every active member of the company. */
  COMPANY: "company",
});

/** Maps each event to its default audience and the in-app notification type. */
const EVENT_METADATA = Object.freeze({
  [NOTIFICATION_EVENTS.LEAVE_REQUESTED]: {
    audience: AUDIENCE.COMPANY_ADMINS,
    inAppType: "leave_request",
  },
  [NOTIFICATION_EVENTS.LEAVE_APPROVED]: {
    audience: AUDIENCE.USER,
    inAppType: "leave_approved",
  },
  [NOTIFICATION_EVENTS.LEAVE_REJECTED]: {
    audience: AUDIENCE.USER,
    inAppType: "leave_rejected",
  },
  [NOTIFICATION_EVENTS.LEAVE_CANCELLED]: {
    audience: AUDIENCE.USER,
    inAppType: "leave_rejected",
  },
  [NOTIFICATION_EVENTS.LEAVE_AUTO_MARKED]: {
    audience: AUDIENCE.USER,
    inAppType: "leave_auto_marked",
  },
  [NOTIFICATION_EVENTS.LEAVE_AUTO_REVERSED]: {
    audience: AUDIENCE.USER,
    inAppType: "leave_auto_reversed",
  },
  [NOTIFICATION_EVENTS.WFH_REQUESTED]: {
    audience: AUDIENCE.COMPANY_ADMINS,
    inAppType: "wfh_request",
  },
  [NOTIFICATION_EVENTS.WFH_APPROVED]: {
    audience: AUDIENCE.USER,
    inAppType: "wfh_approved",
  },
  [NOTIFICATION_EVENTS.WFH_REJECTED]: {
    audience: AUDIENCE.USER,
    inAppType: "wfh_rejected",
  },
  [NOTIFICATION_EVENTS.VOICE_SUBMITTED]: {
    audience: AUDIENCE.COMPANY_ADMINS,
    inAppType: "voice_submitted",
  },
  [NOTIFICATION_EVENTS.VOICE_REPLIED]: {
    audience: AUDIENCE.USER,
    inAppType: "voice_reply",
  },
  [NOTIFICATION_EVENTS.VOICE_STATUS_CHANGED]: {
    audience: AUDIENCE.USER,
    inAppType: "voice_status",
  },
  [NOTIFICATION_EVENTS.ANNOUNCEMENT_PUBLISHED]: {
    audience: AUDIENCE.COMPANY,
    inAppType: "announcement",
  },
  [NOTIFICATION_EVENTS.EMPLOYEE_CREATED]: {
    audience: AUDIENCE.COMPANY_ADMINS,
    inAppType: null,
  },
  [NOTIFICATION_EVENTS.DOCUMENT_APPROVAL_REQUESTED]: {
    audience: AUDIENCE.COMPANY_ADMINS,
    inAppType: null,
  },
  [NOTIFICATION_EVENTS.DOCUMENT_APPROVED]: {
    audience: AUDIENCE.USER,
    inAppType: null,
  },
  [NOTIFICATION_EVENTS.PAYROLL_GENERATED]: {
    audience: AUDIENCE.USER,
    inAppType: null,
  },
});

const isKnownEvent = (event) =>
  Object.prototype.hasOwnProperty.call(EVENT_METADATA, event);

const metadataFor = (event) => EVENT_METADATA[event] || null;

module.exports = {
  NOTIFICATION_EVENTS,
  AUDIENCE,
  EVENT_METADATA,
  isKnownEvent,
  metadataFor,
};
