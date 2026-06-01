const express = require('express');
const router = express.Router();
const authController = require('../controllers/auth.controller');
const { protect } = require('../middlewares/auth');
const { authLimiter, otpLimiter } = require('../middlewares/rateLimiter');

// Public routes
router.post('/quick-guest', authLimiter, authController.quickGuestUser);
router.post('/login', authLimiter, authController.login);
router.post('/register', otpLimiter, authController.register);
router.post('/forgot-password', otpLimiter, authController.forgotPassword);  // Email→Email OTP | Phone→WhatsApp
router.post('/reset-password', authLimiter, authController.resetPassword);
router.post('/send-otp', otpLimiter, authController.sendOTPHandler);
router.post('/verify-otp', authLimiter, authController.verifyOTPHandler);
router.post('/verify-admin-2fa', authLimiter, authController.verifyAdmin2FA);
router.post('/refresh-token', authLimiter, authController.refreshToken);
router.post('/logout', protect, authController.logout);

// Protected routes
router.get('/me', protect, authController.getMe);
router.post('/change-password', protect, authController.changePassword);

module.exports = router;
