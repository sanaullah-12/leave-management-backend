const { verifyToken } = require('../utils/jwt');
const User = require('../models/User');

const authenticateToken = async (req, res, next) => {
  const startTime = Date.now();
  console.log('AUTH MIDDLEWARE START:', req.method, req.url);

  try {
    const authHeader = req.headers['authorization'];
    console.log('Auth header:', authHeader);
    
    const token = authHeader && authHeader.split(' ')[1];
    console.log('Extracted token:', token ? `${token.substring(0, 20)}...` : 'No token');

    if (!token) {
      console.log('AUTH FAILED: No token');
      return res.status(401).json({ message: 'Access token required' });
    }

    console.log('Verifying JWT token...');
    const decoded = verifyToken(token);
    console.log('JWT verified, user ID:', decoded.id);

    console.log('Querying database for user...');
    const dbStart = Date.now();
    const user = await User.findById(decoded.id).populate('company');
    const dbTime = Date.now() - dbStart;
    console.log(`Database query completed in ${dbTime}ms`);

    if (!user || !user.isActive || user.status !== 'active') {
      console.log('AUTH FAILED: Invalid user, inactive, or not verified');
      return res.status(401).json({ message: 'Invalid token, user inactive, or account not verified' });
    }

    req.user = user;
    console.log(`AUTH SUCCESS - User set:`, {
      id: user._id,
      email: user.email,
      role: user.role,
      company: user.company
    });
    const totalTime = Date.now() - startTime;
    console.log(`AUTH SUCCESS in ${totalTime}ms, forwarding to route`);
    next();
  } catch (error) {
    const totalTime = Date.now() - startTime;
    console.error(`AUTH ERROR after ${totalTime}ms:`, error.message);
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