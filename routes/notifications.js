const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const Notification = require('../models/Notification');

const router = express.Router();

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