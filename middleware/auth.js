const { verifyAccessToken } = require('../utils/jwt');
const { findActiveSession } = require('../services/sessionService');
const User = require('../models/User');

/**
 * Verify the bearer token and attach the live user to the request.
 *
 * A valid signature is not enough: the session the token was issued for must
 * still exist and be unrevoked, and the user must still be active. Identity,
 * role and company all come from the database, never from token claims or the
 * request body.
 *
 * Nothing here logs the token, the Authorization header, or the resolved user.
 * This middleware runs on every authenticated request, so anything it prints is
 * duplicated into the platform's log store for the lifetime of the deployment -
 * and a leaked JWT is a working credential for whoever reads it.
 */
const authenticateToken = async (req, res, next) => {
  // Already verified by an earlier guard on the same request (router-level
  // and route-level guards may both run).
  if (req.user && req.authSession) return next();

  const header = req.headers['authorization'];
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Access token required', code: 'TOKEN_MISSING' });
  }
  const token = header.slice(7).trim();

  let decoded;
  try {
    decoded = verifyAccessToken(token);
  } catch (error) {
    return res.status(401).json({
      message: 'Invalid or expired token',
      code: error.name === 'TokenExpiredError' ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID',
    });
  }

  try {
    const [session, user] = await Promise.all([
      findActiveSession(decoded.sid, decoded.sub),
      User.findById(decoded.sub).populate('company'),
    ]);

    if (!session || !user || !user.isActive || user.status !== 'active' || !user.company) {
      return res.status(401).json({ message: 'Session is no longer valid', code: 'SESSION_INVALID' });
    }

    req.user = user;
    req.authSession = session;
    next();
  } catch (error) {
    // A database outage is not an authentication failure: answering 401 here
    // would sign every user out during a transient blip.
    console.error(`Auth lookup failed on ${req.method} ${req.path}:`, error.message);
    return res.status(503).json({ message: 'Service temporarily unavailable' });
  }
};

const authorizeRoles = (...roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ message: 'Authentication required' });
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ message: 'You are not authorized to access this resource' });
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
