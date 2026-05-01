const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { sendOTP, verifyOTP } = require('../services/otp.service');
const ApiResponse = require('../utils/apiResponse');
const logger = require('../utils/logger');

// ─── Helpers ──────────────────────────────────────────────────
const generateTokens = (userId) => ({
  accessToken: jwt.sign({ id: userId }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRE || '1d',
  }),
  refreshToken: jwt.sign({ id: userId }, process.env.JWT_REFRESH_SECRET, {
    expiresIn: process.env.JWT_REFRESH_EXPIRE || '7d',
  }),
});

const setCookies = (res, accessToken, refreshToken) => {
  const opts = {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
  };
  res.cookie('token', accessToken, { ...opts, maxAge: 24 * 60 * 60 * 1000 });
  res.cookie('refreshToken', refreshToken, { ...opts, maxAge: 7 * 24 * 60 * 60 * 1000 });
};

const isEmail = (str) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(str);
const isPhone = (str) => /^\d{10}$/.test(str.replace(/\D/g, ''));

const buildQuery = (identifier) =>
  isEmail(identifier) ? { email: identifier.toLowerCase() } : { phone: identifier.replace(/\D/g, '') };

const autoName = (identifier) => {
  if (isEmail(identifier)) return identifier.split('@')[0].replace(/[._]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  return `User${identifier.slice(-4)}`;
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
    let isNewUser = false;

    // ── First-time login → auto-create account ────────────────
    if (!user) {
      const userData = {
        name: autoName(identifier),
        password,
        isVerified: false,
        role: 'user',
      };
      if (isEmail(identifier)) userData.email = identifier.toLowerCase();
      else userData.phone = identifier.replace(/\D/g, '');

      user = await User.create(userData);
      isNewUser = true;
      logger.info(`Auto-created new user: ${identifier}`);
    } else {
      // ── Returning user checks ─────────────────────────────────
      if (user.isBlocked)
        return ApiResponse.forbidden(res, 'Account blocked. Contact support.');

      // Check if account is locked
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

    const { accessToken, refreshToken } = generateTokens(user._id);
    await User.findByIdAndUpdate(user._id, { refreshToken });
    setCookies(res, accessToken, refreshToken);

    const message = isNewUser ? 'Account created & logged in!' : 'Login successful!';
    logger.info(`${isNewUser ? 'Created' : 'Login'}: ${identifier}`);

    return ApiResponse.success(res, {
      user: { _id: user._id, name: user.name, email: user.email, phone: user.phone, role: user.role, isNewUser },
      accessToken,
    }, message);
  } catch (error) {
    next(error);
  }
};

// ─── POST /auth/forgot-password ───────────────────────────────
// Sends OTP: email → email, phone → WhatsApp
exports.forgotPassword = async (req, res, next) => {
  const { identifier } = req.body;
  logger.info(`🔑 ForgotPassword Attempt: ${identifier}`);
  try {
    if (!identifier)
      return ApiResponse.error(res, 'Email or phone number required', 400);

    const query = buildQuery(identifier);
    logger.info(`🔍 Searching for user with query: ${JSON.stringify(query)}`);
    const user = await User.findOne(query);

    if (!user) {
      logger.warn(`❌ User not found for identifier: ${identifier}`);
      return ApiResponse.error(res, 
        isEmail(identifier)
          ? 'This email is not registered. Please login first to create an account.'
          : 'This phone number is not registered. Please login first to create an account.',
        404
      );
    }

    logger.info(`✅ User found: ${user._id}. Calling sendOTP...`);
    const result = await sendOTP(identifier, 'password_reset');
    logger.info(`✅ sendOTP result: ${JSON.stringify(result)}`);

    const isDevMode = result.method === 'dev_console';

    return ApiResponse.success(res, {
      method: result.method,
      identifier: isEmail(identifier)
        ? identifier.replace(/(.{2}).+(@.+)/, '$1***$2')
        : identifier.replace(/(\d{2})\d+(\d{2})/, '$1*****$2'),
    }, isDevMode
      ? 'OTP sent! Check your server terminal for the code.'
      : `OTP sent successfully to your ${result.method === 'whatsapp' ? 'WhatsApp' : 'email'} at ${identifier}. Please check ${result.method === 'whatsapp' ? 'your mobile' : 'your inbox/spam folder'}.`
    );
  } catch (error) {
    logger.error(`🔥 forgotPassword CRASH for ${identifier}: ${error.stack}`);
    next(error);
  }
};



// ─── POST /auth/send-otp ──────────────────────────────────────
exports.sendOTPHandler = async (req, res, next) => {
  try {
    const { identifier, purpose = 'register' } = req.body;
    if (!identifier)
      return ApiResponse.error(res, 'identifier is required', 400);

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
    res.clearCookie('token');
    res.clearCookie('refreshToken');
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

/**
 * Create a dummy guest user instantly
 */
exports.quickGuestUser = async (req, res, next) => {
  try {
    // 1. Get the current guest count to determine the next sequential ID
    const guestCount = await User.countDocuments({ role: 'user', email: { $regex: /@dummy\.com$/ } });
    const paddedId = String(guestCount + 1).padStart(10, '0');
    
    const guestName = `Guest_${paddedId}`;
    const guestEmail = `guest_${paddedId}@dummy.com`;
    const guestPhone = `00${paddedId.slice(-8)}`; // Unique dummy phone to satisfy unique index
    
    const uniqueId = Date.now().toString().slice(-6); // For password uniqueness

    const user = await User.create({
      name: guestName,
      email: guestEmail,
      phone: guestPhone,
      password: `guest_${paddedId}_${uniqueId}_secret`,
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
