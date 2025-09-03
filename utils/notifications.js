const Notification = require('../models/Notification');

const createNotification = async ({
  recipient,
  sender,
  company,
  type,
  title,
  message,
  leaveId = null
}) => {
  try {
    const notification = new Notification({
      recipient,
      sender,
      company,
      type,
      title,
      message,
      leaveId
    });

    await notification.save();
    return notification;
  } catch (error) {
    console.error('Error creating notification:', error);
    throw error;
  }
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
  notifyLeaveRejection
};