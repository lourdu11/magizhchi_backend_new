const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { sendOTP, verifyOTP } = require('../services/otp.service');
const ApiResponse = require('../utils/apiResponse');
const { logAudit } = require('../utils/auditLogger');
const logger = require('../utils/logger');

// ─── Helpers ──────────────────────────────────────────────────
const generateTokens = (userId) => ({
  accessToken: jwt.sign({ id: userId }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRE || '15m',
  }),
  refreshToken: jwt.sign({ id: userId }, process.env.JWT_REFRESH_SECRET, {
    expiresIn: process.env.JWT_REFRESH_EXPIRE || '7d',
  }),
});

const setCookies = (res, accessToken, refreshToken) => {
  const isProduction = process.env.NODE_ENV === 'production';
  const opts = {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? 'none' : 'lax',
    // Required for cross-site cookies in modern browsers (Chrome 130+, Firefox)
    // Frontend (Vercel) and backend (Render) are on different domains
    ...(isProduction && { partitioned: true }),
  };
  res.cookie('token', accessToken, { ...opts, maxAge: 24 * 60 * 60 * 1000 });
  res.cookie('refreshToken', refreshToken, { ...opts, maxAge: 7 * 24 * 60 * 60 * 1000 });
};


const { normalizePhone } = require('../utils/normalize');

const isEmail = (str) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(str);
const isPhone = (str) => /^\d{10}$/.test(normalizePhone(str));

const buildQuery = (identifier) =>
  isEmail(identifier) ? { email: identifier.toLowerCase() } : { phone: normalizePhone(identifier) };

const autoName = (identifier) => {
  if (isEmail(identifier)) return identifier.split('@')[0].replace(/[._]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  return `User${normalizePhone(identifier).slice(-4)}`;
};

// ─── POST /auth/login (Smart: auto-creates on first visit) ────
exports.login = async (req, res, next) => {
  try {
    const { identifier, password } = req.body;
    if (!identifier || !password)
      return ApiResponse.error(res, 'Phone/email and password are required', 400);
    if (password.length < 8)
      return ApiResponse.error(res, 'Password must be at least 8 characters', 400);

    const query = buildQuery(identifier);
    let user = await User.findOne(query).select('+password');
    const isNewUser = false;

    // ── First-time login → auto-create account ────────────────
    if (!user) {
      return ApiResponse.unauthorized(res, 'Account not found. Create an account first.');
    } else {
      // ── Returning user checks ─────────────────────────────────
      if (user.isBlocked)
        return ApiResponse.forbidden(res, 'Account blocked. Contact support.');

      // Check if account is locked (Disabled for development ease)
      if (user.lockUntil && user.lockUntil > Date.now()) {
        const remaining = Math.ceil((user.lockUntil - Date.now()) / 60000);
        return ApiResponse.error(res, `Too many failed attempts. Try after ${remaining} minutes.`, 423);
      }

      const isMatch = await user.comparePassword(password);
      if (!isMatch) {
        const newAttempts = (user.loginAttempts || 0) + 1;
        const updateData = { loginAttempts: newAttempts };
        if (newAttempts >= 5) {
          updateData.lockUntil = new Date(Date.now() + 15 * 60 * 1000); // lock 15 min
        }
        await User.findByIdAndUpdate(user._id, updateData);
        const remaining = Math.max(0, 5 - newAttempts);
        return ApiResponse.error(
          res,
          `Incorrect password.${remaining > 0 ? ` ${remaining} attempts left.` : ' Account locked for 15 min.'}`,
          401
        );
      }
    }

    // Reset login attempts on success
    await User.findByIdAndUpdate(user._id, { $set: { loginAttempts: 0 }, $unset: { lockUntil: 1 } });

    // ── Admin/Staff 2FA Challenge ───────────────────────────────
    if (user.role === 'admin' || user.role === 'staff') {
      logger.info(`🛡️ 2FA Challenge initiated for ${user.role}: ${identifier}`);
      
      const result = await sendOTP(identifier, 'admin_2fa');
      
      return ApiResponse.success(res, {
        status: 'OTP_REQUIRED',
        method: result.method,
        identifier: isEmail(identifier)
          ? identifier.replace(/(.{2}).+(@.+)/, '$1***$2')
          : identifier.replace(/(\d{2})\d+(\d{2})/, '$1*****$2'),
      }, `Login secure: Enter the code sent to your ${result.method === 'whatsapp' ? 'WhatsApp' : 'email'}.`);
    }

    const { accessToken, refreshToken } = generateTokens(user._id);
    await User.findByIdAndUpdate(user._id, { refreshToken });
    setCookies(res, accessToken, refreshToken);

    const message = isNewUser ? 'Account created & logged in!' : 'Login successful!';
    logger.info(`${isNewUser ? 'Created' : 'Login'}: ${identifier}`);

    logAudit({ userId: user._id, action: isNewUser ? 'SIGNUP' : 'LOGIN', module: 'AUTH', details: { identifier } });

    return ApiResponse.success(res, {
      user: { _id: user._id, name: user.name, email: user.email, phone: user.phone, role: user.role, isNewUser },
      accessToken,
    }, message);
  } catch (error) {
    next(error);
  }
};

// ─── POST /auth/verify-admin-2fa ──────────────────────────────
exports.verifyAdmin2FA = async (req, res, next) => {
  try {
    const { identifier, otp } = req.body;
    if (!identifier || !otp) {
      return ApiResponse.error(res, 'Identity and security code are required', 400);
    }

    // 1. Verify OTP
    await verifyOTP(identifier, otp, 'admin_2fa', true);

    // 2. Fetch User
    const query = buildQuery(identifier);
    const user = await User.findOne(query);
    if (!user) return ApiResponse.notFound(res, 'Administrator record not found');
    if (!['admin', 'staff'].includes(user.role)) {
      return ApiResponse.forbidden(res, 'Administrator access is required');
    }

    // 3. Issue Tokens
    const { accessToken, refreshToken } = generateTokens(user._id);
    await User.findByIdAndUpdate(user._id, { refreshToken });
    setCookies(res, accessToken, refreshToken);

    logger.info(`🔐 2FA SUCCESS: ${user.role} logged in: ${identifier}`);

    return ApiResponse.success(res, {
      user: { _id: user._id, name: user.name, email: user.email, phone: user.phone, role: user.role },
      accessToken,
    }, 'Access Authorized. Welcome back.');
  } catch (error) {
    next(error);
  }
};

// ─── POST /auth/forgot-password ───────────────────────────────
// Sends OTP: email → email, phone → WhatsApp
exports.forgotPassword = async (req, res, next) => {
  const { identifier } = req.body;
  logger.info(`🔥🔥🔥 FORGOT PASSWORD START: ${identifier}`);
  try {
    if (!identifier) {
      logger.warn('❌ ForgotPassword: No identifier provided');
      return ApiResponse.error(res, 'Email or phone number required', 400);
    }

    const query = buildQuery(identifier);
    logger.info(`🔍 ForgotPassword: Query = ${JSON.stringify(query)}`);
    
    const user = await User.findOne(query);

    if (!user) {
      logger.warn(`❌ ForgotPassword: User not found for ${identifier}`);
      return ApiResponse.error(res, 
        isEmail(identifier)
          ? 'This email is not registered.'
          : 'This phone number is not registered.',
        404
      );
    }

    logger.info(`✅ ForgotPassword: User found (${user._id}). Sending OTP...`);
    
    try {
      const result = await sendOTP(identifier, 'password_reset');
      logger.info(`✅ ForgotPassword: sendOTP Success: ${JSON.stringify(result)}`);

      return ApiResponse.success(res, {
        method: result.method,
        identifier: isEmail(identifier)
          ? identifier.replace(/(.{2}).+(@.+)/, '$1***$2')
          : identifier.replace(/(\d{2})\d+(\d{2})/, '$1*****$2'),
      }, `OTP sent successfully to your ${result.method === 'whatsapp' ? 'WhatsApp' : 'email'}.`);
    } catch (otpErr) {
      logger.error(`❌ ForgotPassword: sendOTP FAILED: ${otpErr.message}`);
      logger.error(otpErr.stack);
      return ApiResponse.error(res, `Failed to send OTP: ${otpErr.message}`, 500);
    }
  } catch (error) {
    logger.error(`🔥 ForgotPassword GLOBAL CRASH: ${error.message}`);
    logger.error(error.stack);
    next(error);
  }
};



// ─── POST /auth/send-otp ──────────────────────────────────────
exports.sendOTPHandler = async (req, res, next) => {
  try {
    const { identifier, purpose = 'register' } = req.body;
    if (!identifier)
      return ApiResponse.error(res, 'identifier is required', 400);
    if (purpose !== 'register') {
      return ApiResponse.error(res, 'Unsupported OTP purpose', 400);
    }

    const result = await sendOTP(identifier, purpose);
    return ApiResponse.success(res, { method: result.method }, result.message);
  } catch (error) {
    next(error);
  }
};

// ─── POST /auth/verify-otp ────────────────────────────────────
exports.verifyOTPHandler = async (req, res, next) => {
  try {
    const { identifier, otp, purpose = 'register' } = req.body;
    if (!identifier || !otp) {
      return ApiResponse.error(res, 'Both identifier and OTP are required', 400);
    }
    if (!['register', 'password_reset'].includes(purpose)) {
      return ApiResponse.error(res, 'Unsupported OTP purpose', 400);
    }

    // For password reset, don't delete yet; it's needed for the final reset call
    const deleteAfter = purpose !== 'password_reset';
    await verifyOTP(identifier, otp, purpose, deleteAfter);
    return ApiResponse.success(res, null, 'OTP verified successfully');
  } catch (error) {
    next(error);
  }
};

// ─── POST /auth/reset-password ────────────────────────────────
exports.resetPassword = async (req, res, next) => {
  try {
    const { identifier, otp, newPassword } = req.body;
    if (!identifier || !otp || !newPassword)
      return ApiResponse.error(res, 'All fields required', 400);
    if (newPassword.length < 8)
      return ApiResponse.error(res, 'Password must be at least 8 characters', 400);

    // 1. Verify OTP but DON'T delete yet
    await verifyOTP(identifier, otp, 'password_reset', false);

    // 2. Find user (include password to ensure full document for .save())
    const user = await User.findOne(buildQuery(identifier)).select('+password');
    if (!user) return ApiResponse.notFound(res, 'User not found');

    // 3. Update password
    user.password = newPassword;
    user.loginAttempts = 0;
    user.lockUntil = undefined;
    
    // 3.1. Ensure name exists (fixes 422 "Path name is required" for older users)
    if (!user.name) {
      user.name = autoName(identifier);
      logger.info(`Assigned fallback name to user ${identifier}: ${user.name}`);
    }
    
    try {

      await user.save();
    } catch (saveError) {
      logger.error('Error saving new password:', saveError.message);
      throw saveError; // Will be caught by outer catch and sent as 422 if validation fails
    }

    // 4. Success! Now safe to delete the OTP
    const OTP = require('../models/OTP');
    await OTP.deleteOne({ identifier, purpose: 'password_reset' });

    const { accessToken, refreshToken } = generateTokens(user._id);
    await User.findByIdAndUpdate(user._id, { refreshToken });
    setCookies(res, accessToken, refreshToken);

    logger.info(`Password reset success: ${identifier}`);
    logAudit({ userId: user._id, action: 'PASSWORD_RESET', module: 'AUTH', details: { identifier } });

    return ApiResponse.success(res, {
      user: { _id: user._id, name: user.name, email: user.email, phone: user.phone, role: user.role },
      accessToken,
    }, 'Password reset successful! You are now logged in.');
  } catch (error) {
    next(error);
  }
};


// ─── POST /auth/logout ────────────────────────────────────────
exports.logout = async (req, res, next) => {
  try {
    if (req.user?._id) {
      await User.findByIdAndUpdate(req.user._id, { $unset: { refreshToken: 1 } });
    }
    const isProduction = process.env.NODE_ENV === 'production';
    const opts = {
      httpOnly: true,
      secure: isProduction,
      sameSite: isProduction ? 'none' : 'lax',
      ...(isProduction && { partitioned: true }),
    };
    res.clearCookie('token', opts);
    res.clearCookie('refreshToken', opts);
    return ApiResponse.success(res, null, 'Logged out successfully');
  } catch (error) {
    next(error);
  }
};

// ─── GET /auth/me ─────────────────────────────────────────────
exports.getMe = async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id).select('-password -refreshToken');
    return ApiResponse.success(res, { user });
  } catch (error) {
    next(error);
  }
};

// ─── POST /auth/refresh-token ─────────────────────────────────
exports.refreshToken = async (req, res, next) => {
  try {
    const token = req.cookies?.refreshToken || req.body?.refreshToken;
    if (!token) return ApiResponse.unauthorized(res, 'No refresh token');

    const decoded = jwt.verify(token, process.env.JWT_REFRESH_SECRET);
    const user = await User.findById(decoded.id).select('+refreshToken');
    if (!user || user.refreshToken !== token)
      return ApiResponse.unauthorized(res, 'Invalid refresh token');

    const { accessToken, refreshToken } = generateTokens(user._id);
    await User.findByIdAndUpdate(user._id, { refreshToken });
    setCookies(res, accessToken, refreshToken);

    return ApiResponse.success(res, { accessToken }, 'Token refreshed');
  } catch (error) {
    next(error);
  }
};

// ─── POST /auth/change-password (Authenticated) ───────────────
exports.changePassword = async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword)
      return ApiResponse.error(res, 'Both passwords required', 400);
    if (newPassword.length < 8)
      return ApiResponse.error(res, 'New password must be at least 8 characters', 400);

    const user = await User.findById(req.user._id).select('+password');
    const isMatch = await user.comparePassword(currentPassword);
    if (!isMatch) return ApiResponse.error(res, 'Current password is incorrect', 401);

    user.password = newPassword;
    await user.save();

    return ApiResponse.success(res, null, 'Password changed successfully');
  } catch (error) {
    next(error);
  }
};

exports.register = async (req, res, next) => {
  try {
    const { name, email, phone, password, otp } = req.body;
    const identifier = email || phone;
    if (!name?.trim() || !identifier || !password || !otp) {
      return ApiResponse.error(res, 'Name, email or phone, password, and OTP are required', 400);
    }
    if (password.length < 8) {
      return ApiResponse.error(res, 'Password must be at least 8 characters', 400);
    }
    if (!isEmail(identifier) && !isPhone(identifier)) {
      return ApiResponse.error(res, 'Enter a valid email or 10-digit phone number', 400);
    }

    await verifyOTP(identifier, otp, 'register', true);
    const query = buildQuery(identifier);
    if (await User.exists(query)) {
      return ApiResponse.error(res, 'An account already exists for this email or phone number', 409);
    }

    const user = await User.create({
      name: name.trim(),
      ...(isEmail(identifier) ? { email: identifier.toLowerCase() } : { phone: normalizePhone(identifier) }),
      password,
      role: 'user',
      isVerified: true
    });
    const { accessToken, refreshToken } = generateTokens(user._id);
    await User.findByIdAndUpdate(user._id, { refreshToken });
    setCookies(res, accessToken, refreshToken);
    logAudit({ userId: user._id, action: 'SIGNUP', module: 'AUTH', details: { identifier } });
    return ApiResponse.created(res, {
      user: { _id: user._id, name: user.name, email: user.email, phone: user.phone, role: user.role },
      accessToken
    }, 'Account created successfully');
  } catch (error) {
    next(error);
  }
};

/**
 * Create a dummy guest user instantly
 */
exports.quickGuestUser = async (req, res, next) => {
  try {
    // 1. Generate a sequential 10-digit numeric ID using getNextSequence
    const { getNextSequence } = require('../utils/generateNumbers');
    const seq = await getNextSequence('guest_user');
    const uniqueId = String(seq).padStart(10, '0');
    
    const guestName = `Guest_${uniqueId}`;
    const guestEmail = `guest_${uniqueId}@dummy.com`;
    const guestPhone = uniqueId; 
    
    const passwordSuffix = Date.now().toString().slice(-6); // For password uniqueness
    const guestPassword = `guest_${uniqueId}_${passwordSuffix}_secret`;

    const user = await User.create({
      name: guestName,
      email: guestEmail,
      phone: guestPhone,
      password: guestPassword,
      role: 'user',
      isVerified: true
    });

    const { accessToken, refreshToken } = generateTokens(user._id);
    await User.findByIdAndUpdate(user._id, { refreshToken });
    setCookies(res, accessToken, refreshToken);

    return ApiResponse.success(res, {
      user: { _id: user._id, name: user.name, email: user.email, role: user.role },
      accessToken
    }, 'Demo profile created! Welcome to Magizhchi.');
  } catch (error) { next(error); }
};
