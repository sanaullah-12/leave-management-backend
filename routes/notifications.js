const express = require('express');
const { authenticateToken, authorizeRoles } = require('../middleware/auth');
const Notification = require('../models/Notification');
const {
  WhatsAppNotificationService,
  NotificationQueue,
  NotificationLogger,
  phone: phoneUtil,
} = require('../notifications');

const router = express.Router();

// -- Operations ------------------------------------------------------------
// Delivery through a third party fails quietly by nature: nobody files a
// ticket for a message that never arrived. These endpoints let an admin see
// the channel's real state and prove a send works, without shell access.
// They are declared before the parameterised routes below so their paths are
// never swallowed by a "/:id" match.

// Is the WhatsApp channel actually able to deliver right now?
router.get(
  '/whatsapp/health',
  authenticateToken,
  authorizeRoles('admin'),
  (req, res) => {
    const health = WhatsAppNotificationService.health();
    res.status(200).json({
      whatsapp: health,
      queue: NotificationQueue.getStats(),
      counters: NotificationLogger.stats(),
      // Healthy means: switched on, a real provider is configured, and nothing
      // in the configuration would prevent delivery.
      healthy:
        health.enabled &&
        health.problems.length === 0 &&
        health.activeProvider !== 'log',
    });
  }
);

// Recent queue activity - what was delivered, what died, and why.
router.get(
  '/whatsapp/queue',
  authenticateToken,
  authorizeRoles('admin'),
  (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 25, 100);
    res.status(200).json({
      stats: NotificationQueue.getStats(),
      recent: NotificationQueue.getHistory(limit),
    });
  }
);

// Sends one message immediately, bypassing the queue and the templates, so a
// misconfiguration surfaces here as an error rather than as silence later.
router.post(
  '/whatsapp/test',
  authenticateToken,
  authorizeRoles('admin'),
  async (req, res) => {
    const { to, message } = req.body || {};

    const destination = to || req.user.phone;
    if (!destination) {
      return res.status(400).json({
        message:
          'Provide a "to" number, or add a phone number to your own profile to test against it.',
      });
    }

    if (!phoneUtil.normalize(destination)) {
      return res.status(400).json({
        message: `Invalid phone number. ${phoneUtil.HUMAN_READABLE_RULE}`,
        field: 'to',
      });
    }

    try {
      const result = await WhatsAppNotificationService.sendDirect({
        to: destination,
        body:
          message ||
          'Nexora HRMS test message. If you can read this, WhatsApp notifications are configured correctly.',
      });

      res.status(200).json({
        message: 'Test message accepted by the provider',
        provider: result.provider,
        providerMessageId: result.providerMessageId,
        to: phoneUtil.mask(phoneUtil.normalize(destination)),
      });
    } catch (error) {
      // A failed test is expected output here, not a server fault: report the
      // provider's own reason so the admin can act on it.
      res.status(502).json({
        message: 'Test message was not accepted',
        reason: error.message,
        retryable: error.retryable !== false,
        provider: error.provider || null,
      });
    }
  }
);

// Get user notifications
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { page = 1, limit = 20, unread = false } = req.query;
    
    const query = {
      recipient: req.user._id,
      company: req.user.company._id
    };
    
    if (unread === 'true') {
      query.read = false;
    }
    
    const notifications = await Notification.find(query)
      .populate('sender', 'name employeeId')
      .populate('leaveId', 'leaveType startDate endDate totalDays')
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    const total = await Notification.countDocuments(query);
    const unreadCount = await Notification.countDocuments({
      recipient: req.user._id,
      company: req.user.company._id,
      read: false
    });

    res.status(200).json({
      notifications,
      pagination: {
        current: parseInt(page),
        pages: Math.ceil(total / limit),
        total,
        unreadCount
      }
    });

  } catch (error) {
    console.error('Get notifications error:', error);
    res.status(500).json({ 
      message: 'Failed to get notifications', 
      error: error.message 
    });
  }
});

// Mark notification as read
router.put('/:id/read', authenticateToken, async (req, res) => {
  try {
    const notification = await Notification.findOneAndUpdate(
      { 
        _id: req.params.id, 
        recipient: req.user._id,
        company: req.user.company._id
      },
      { 
        read: true, 
        readAt: new Date() 
      },
      { new: true }
    );

    if (!notification) {
      return res.status(404).json({ message: 'Notification not found' });
    }

    res.status(200).json({ notification });

  } catch (error) {
    console.error('Mark notification as read error:', error);
    res.status(500).json({ 
      message: 'Failed to mark notification as read', 
      error: error.message 
    });
  }
});

// Mark all notifications as read
router.put('/mark-all-read', authenticateToken, async (req, res) => {
  try {
    await Notification.updateMany(
      { 
        recipient: req.user._id,
        company: req.user.company._id,
        read: false 
      },
      { 
        read: true, 
        readAt: new Date() 
      }
    );

    res.status(200).json({ message: 'All notifications marked as read' });

  } catch (error) {
    console.error('Mark all notifications as read error:', error);
    res.status(500).json({ 
      message: 'Failed to mark all notifications as read', 
      error: error.message 
    });
  }
});

// Delete notification
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const notification = await Notification.findOneAndDelete({
      _id: req.params.id,
      recipient: req.user._id,
      company: req.user.company._id
    });

    if (!notification) {
      return res.status(404).json({ message: 'Notification not found' });
    }

    res.status(200).json({ message: 'Notification deleted successfully' });

  } catch (error) {
    console.error('Delete notification error:', error);
    res.status(500).json({ 
      message: 'Failed to delete notification', 
      error: error.message 
    });
  }
});

module.exports = router;