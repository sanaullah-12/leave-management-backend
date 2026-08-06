/**
 * notifications/index.js
 * ----------------------
 * The notification layer's public surface.
 *
 * Business code should require this file and nothing deeper. Everything inside
 * the folder - channels, providers, the queue, the templates - is an
 * implementation detail that is free to change as long as `dispatch` and the
 * event vocabulary hold.
 *
 *   const { NotificationService, NOTIFICATION_EVENTS } = require("../notifications");
 *
 *   await NotificationService.dispatch({
 *     event: NOTIFICATION_EVENTS.LEAVE_REQUESTED,
 *     companyId: leave.company,
 *     senderId: leave.employee._id,
 *     refs: { leaveId: leave._id },
 *     payload: { employeeName, leaveType, totalDays, startDate, endDate },
 *   });
 */

const NotificationService = require("./NotificationService");
const SocketNotificationService = require("./SocketNotificationService");
const WhatsAppNotificationService = require("./WhatsAppNotificationService");
const NotificationQueue = require("./NotificationQueue");
const NotificationTemplates = require("./NotificationTemplates");
const NotificationLogger = require("./NotificationLogger");
const RecipientResolver = require("./RecipientResolver");
const providers = require("./providers");
const phone = require("./phone");
const config = require("./config");
const {
  NOTIFICATION_EVENTS,
  AUDIENCE,
  EVENT_METADATA,
} = require("./NotificationEvents");

module.exports = {
  // Primary entry point
  NotificationService,
  NOTIFICATION_EVENTS,
  AUDIENCE,
  EVENT_METADATA,

  // Channels
  SocketNotificationService,
  WhatsAppNotificationService,

  // Infrastructure
  NotificationQueue,
  NotificationTemplates,
  NotificationLogger,
  RecipientResolver,
  providers,
  phone,
  config,
};
