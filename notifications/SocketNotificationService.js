/**
 * SocketNotificationService.js
 * ----------------------------
 * The in-app channel: persist a Notification document, then push it to the
 * recipient's socket room.
 *
 * This is the existing, working notification path, moved behind the channel
 * interface without a change in behaviour. It is deliberately the only channel
 * that is synchronous and unqueued: the document write is the notification (it
 * backs the bell and the notification centre), so it belongs in the same
 * failure domain as the caller, not behind a queue that could lose it.
 *
 * The socket emit itself is already fail-safe inside SocketService - a socket
 * hiccup never propagates to the caller.
 */

const Notification = require("../models/Notification");
const SocketService = require("../socket/socketService");
const logger = require("./NotificationLogger");

class SocketNotificationService {
  constructor() {
    this.name = "socket";
  }

  /** The in-app channel is core product surface and is never switched off. */
  isEnabled() {
    return true;
  }

  /**
   * Creates and delivers one in-app notification.
   *
   * @param {object} recipient  Resolved recipient ({ _id, name, ... }).
   * @param {object} message
   * @param {string} message.type      Notification.type enum value.
   * @param {string} message.title
   * @param {string} message.body
   * @param {string} message.company
   * @param {string=} message.sender
   * @param {object=} message.refs     { leaveId, voiceId, announcementId, wfhId }
   * @returns {Promise<object>} The persisted notification document.
   */
  async send(recipient, message) {
    const { type, title, body, company, sender, refs = {} } = message;

    const notification = new Notification({
      recipient: recipient._id,
      sender: sender || undefined,
      company,
      type,
      title,
      message: body,
      leaveId: refs.leaveId || null,
      voiceId: refs.voiceId || null,
      announcementId: refs.announcementId || null,
      wfhId: refs.wfhId || null,
    });

    await notification.save();

    // Real-time: push to the recipient's room instantly.
    // Fail-safe - a socket hiccup must never break notification creation.
    SocketService.toUser(recipient._id, SocketService.events.NOTIFICATION_NEW, {
      _id: notification._id,
      type: notification.type,
      title: notification.title,
      message: notification.message,
      leaveId: notification.leaveId,
      voiceId: notification.voiceId,
      announcementId: notification.announcementId,
      wfhId: notification.wfhId,
      read: false,
      createdAt: notification.createdAt,
    });

    logger.count("socketSent");
    logger.debug("In-app notification delivered", {
      channel: this.name,
      recipient: String(recipient._id),
      type,
    });

    return notification;
  }
}

module.exports = new SocketNotificationService();
module.exports.SocketNotificationService = SocketNotificationService;
