const express = require('express');
const router = express.Router();
const authController = require('../controllers/auth.controller');
const { protect } = require('../middlewares/auth');
const { authLimiter, otpLimiter } = require('../middlewares/rateLimiter');

// Public routes
router.post('/quick-guest', authController.quickGuestUser);
router.post('/login', authLimiter, authController.login);            // Smart login (auto-creates)
router.post('/forgot-password', otpLimiter, authController.forgotPassword);  // Email→Email OTP | Phone→WhatsApp
router.post('/reset-password', authController.resetPassword);
router.post('/send-otp', otpLimiter, authController.sendOTPHandler);
router.post('/verify-otp', authController.verifyOTPHandler);
router.post('/refresh-token', authController.refreshToken);
router.post('/logout', authController.logout);

// Protected routes
router.get('/me', protect, authController.getMe);
router.post('/change-password', protect, authController.changePassword);

module.exports = router;
