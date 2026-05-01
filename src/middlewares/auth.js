const jwt = require('jsonwebtoken');
const User = require('../models/User');
const ApiResponse = require('../utils/apiResponse');

/**
 * Verify JWT token from Authorization header or httpOnly cookie
 */
const protect = async (req, res, next) => {
  try {
    let token;
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
      token = req.headers.authorization.split(' ')[1];
    } else if (req.cookies && req.cookies.token) {
      token = req.cookies.token;
    }

    if (!token) {
      return ApiResponse.unauthorized(res, 'Access denied. No token provided.');
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id).select('-password');

    if (!user) {
      return ApiResponse.unauthorized(res, 'User not found. Token invalid.');
    }

    if (user.isBlocked) {
      return ApiResponse.forbidden(res, 'Your account has been blocked. Contact support.');
    }

    req.user = user;
    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return ApiResponse.unauthorized(res, 'Token expired. Please login again.');
    }
    return ApiResponse.unauthorized(res, 'Invalid token.');
  }
};

/**
 * Allow access only to specific roles
 */
const authorize = (...roles) => {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return ApiResponse.forbidden(res, `Role '${req.user.role}' is not authorized.`);
    }
    next();
  };
};

const isAdmin = authorize('admin');
const isStaff = authorize('admin', 'staff');
const isUser = authorize('admin', 'staff', 'user');

/**
 * Optional auth - attaches user if token exists, proceeds regardless
 */
const optionalAuth = async (req, res, next) => {
  try {
    let token;
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
      token = req.headers.authorization.split(' ')[1];
    } else if (req.cookies && req.cookies.token) {
      token = req.cookies.token;
    }

    if (token) {
      try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const user = await User.findById(decoded.id).select('-password');
        if (user && !user.isBlocked) {
          req.user = user;
        }
      } catch (e) {
        // Token invalid or expired — continue as guest
      }
    }
  } catch (err) {
    // Silent fail — guest access still proceeds
  }
  next();
};

module.exports = { protect, authorize, isAdmin, isStaff, isUser, optionalAuth };
