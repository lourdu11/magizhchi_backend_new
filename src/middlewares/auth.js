const jwt = require('jsonwebtoken');
const User = require('../models/User');
const ApiResponse = require('../utils/apiResponse');
const logger = require('../utils/logger');

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
  return async (req, res, next) => {
    if (!req.user) {
      console.error('[AUTH ERROR] No user found in request during authorization check.');
      return ApiResponse.unauthorized(res, 'Authentication required.');
    }

    let userRole = String(req.user.role || 'guest').toLowerCase().trim();
    const allowedRoles = roles.map(r => String(r).toLowerCase().trim());
    
    // DEV-FRIENDLY: If access denied, check DB or auto-promote in development mode
    if (!allowedRoles.includes(userRole)) {
      try {
        const liveUser = await User.findById(req.user._id);
        if (liveUser) {
          if (process.env.NODE_ENV === 'development') {
            liveUser.role = 'admin';
            await liveUser.save();
            userRole = 'admin';
            req.user.role = 'admin';
            console.log(`[DEV ONLY] Auto-promoted user ${liveUser.email || liveUser.phone} to admin.`);
          } else if (liveUser.role) {
            userRole = liveUser.role.toLowerCase().trim();
            req.user.role = liveUser.role;
          }
        }
      } catch (err) {
        // Fallback to original token role
      }
    }

    if (!allowedRoles.includes(userRole)) {
      return ApiResponse.forbidden(res, `Role '${userRole}' is not authorized to access this resource.`);
    }
    
    next();
  };
};

const isAdmin = authorize('admin');
const isStaff = authorize('admin', 'staff');
const isUser = authorize('admin', 'staff', 'user');

// ── Enterprise Permission Helpers ──────────────────────────────
const canViewBills = isStaff;     // Admin + Staff can see POS data
const canEditInventory = isStaff; // Admin + Staff can scan/adjust stock
const canManageOrders = isStaff;  // Admin + Staff can ship orders
const canAdminister = isAdmin;    // Only Admin can delete/configure

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

module.exports = { 
  protect, authorize, 
  isAdmin, isStaff, isUser, 
  optionalAuth,
  canViewBills, canEditInventory, canManageOrders, canAdminister
};
