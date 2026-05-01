const mongoose = require('mongoose');

const otpSchema = new mongoose.Schema(
  {
    identifier: { type: String, required: true, trim: true }, // email or phone
    otp: { type: String, required: true },
    // purpose replaces 'type' — supports any string (register, login, password_reset, etc.)
    purpose: {
      type: String,
      enum: ['register', 'login', 'password_reset', 'verify_email', 'verify_phone'],
      required: true,
      default: 'register',
    },
    attempts: { type: Number, default: 0 }, // track wrong guesses
    expiresAt: {
      type: Date,
      required: true,
      default: () => new Date(Date.now() + 10 * 60 * 1000), // 10 minutes
    },
  },
  { timestamps: true }
);

// TTL index: MongoDB auto-deletes expired OTPs (no manual cleanup needed)
otpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
otpSchema.index({ identifier: 1, purpose: 1 });

module.exports = mongoose.model('OTP', otpSchema);
