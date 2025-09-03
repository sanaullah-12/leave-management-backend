const { verifyToken } = require('../utils/jwt');
const User = require('../models/User');

const authenticateToken = async (req, res, next) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
      return res.status(401).json({ message: 'Access token required' });
    }

    const decoded = verifyToken(token);
    const user = await User.findById(decoded.id).populate('company');

    if (!user || !user.isActive || user.status !== 'active') {
      return res.status(401).json({ message: 'Invalid token, user inactive, or account not verified' });
    }

    req.user = user;
    next();
  } catch (error) {
    return res.status(401).json({ message: 'Invalid token' });
  }
};

const authorizeRoles = (...roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ message: 'Authentication required' });
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ 
        message: `Role ${req.user.role} is not authorized to access this resource` 
      });
    }

    next();
  };
};

const checkCompanyAccess = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ message: 'Authentication required' });
  }

  // Admin can access their company's data
  // Employee can only access their own data
  if (req.user.role === 'admin') {
    req.companyId = req.user.company._id;
  } else {
    // For employees, they can only access their own data
    if (req.params.id && req.params.id !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Access denied' });
    }
    req.companyId = req.user.company._id;
  }

  next();
};

module.exports = {
  authenticateToken,
  authorizeRoles,
  checkCompanyAccess
};