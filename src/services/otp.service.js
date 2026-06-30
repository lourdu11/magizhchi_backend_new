const OTP = require('../models/OTP');
const logger = require('../utils/logger');
const crypto = require('crypto');

// ─── Generate 6-digit OTP ─────────────────────────────────────
const generateOTP = () => String(crypto.randomInt(100000, 1000000));

// ─── Send via Email ────────────────────────────────────────────
const sendEmailOTP = async (email, otp, purpose) => {
  const { sendOTPEmail } = require('./email.service');
  await sendOTPEmail(email, otp, purpose);
  logger.info(`Email OTP sent to: ${email}`);
};

// ─── Send via YOUR WhatsApp (QR scan) ─────────────────────────
const sendWhatsAppOTP_Own = async (phone, otp, purpose) => {
  const { sendWhatsAppOTP } = require('./whatsapp.service');
  await sendWhatsAppOTP(phone, otp, purpose);
};

// ─── Smart Router ──────────────────────────────────────────────
const sendOTP = async (rawIdentifier, purpose = 'register') => {
  const isEmailId = rawIdentifier.includes('@');
  const identifier = isEmailId ? rawIdentifier.toLowerCase().trim() : rawIdentifier.replace(/\D/g, '');
  const isPhoneId = !isEmailId && identifier.length >= 10;

  const otp = generateOTP();
  const expireMinutes = parseInt(process.env.OTP_EXPIRE_MINUTES || '10');
  const isDev = process.env.NODE_ENV !== 'production';

  // Save OTP to DB
  logger.info(`📟 OTP: Deleting existing for ${identifier}`);
  await OTP.findOneAndDelete({ identifier, purpose });
  
  logger.info(`📟 OTP: Creating new record...`);
  await OTP.create({
    identifier,
    purpose,
    otp,
    expiresAt: new Date(Date.now() + expireMinutes * 60 * 1000),
  });
  logger.info(`📟 OTP: DB record created successfully.`);

  if (process.env.NODE_ENV !== 'production') {
    logger.info(`DEBUG: Flow Detection -> isEmail: ${isEmailId} isPhone: ${isPhoneId} normalized: ${identifier}`);
    
    // Always log OTP in terminal (dev safety net)
    logger.info('');
    logger.info('╔══════════════════════════════════════╗');
    logger.info(`║  OTP: ${otp}   → ${identifier.substring(0, 20).padEnd(20)} ║`);
    logger.info('╚══════════════════════════════════════╝');
    logger.info('');
  }

  // ── Email ──────────────────────────────────────────────────
  if (isEmailId) {
    try {
      await sendEmailOTP(identifier, otp, purpose);
      return { method: 'email', message: `OTP Sent! Check your ${maskEmail(identifier)}.` };
    } catch (err) {
      logger.error(`❌ EMAIL OTP SEND ERROR to ${identifier}:`, err.message);
      if (isDev) {
        return { 
          method: 'dev_console', 
          message: `OTP logged in terminal (Email failed: ${err.message}). Check your .env SMTP settings.` 
        };
      }
      throw err;
    }
  }

  // ── Phone → Try WhatsApp first, fallback to email ──────────
  if (isPhoneId) {
    // Try WhatsApp first
    try {
      await sendWhatsAppOTP_Own(identifier, otp, purpose);
      return { method: 'whatsapp', message: `OTP Sent! Check WhatsApp ${maskPhone(identifier)}.` };
    } catch (whatsappErr) {
      logger.error(`❌ WHATSAPP OTP SEND ERROR to ${identifier}:`, whatsappErr.message);
      logger.warn(`⚠️  WhatsApp failed — attempting email fallback for ${identifier}`);

      // ── Email fallback: look up the user's email from DB ──
      try {
        const User = require('../models/User');
        const user = await User.findOne({ phone: identifier }).select('email');
        if (user?.email) {
          // Re-save OTP under email identifier so verifyOTP finds it
          await OTP.findOneAndDelete({ identifier: user.email, purpose });
          await OTP.create({
            identifier: user.email,
            purpose,
            otp,
            expiresAt: new Date(Date.now() + expireMinutes * 60 * 1000),
          });
          
          await sendEmailOTP(user.email, otp, purpose);
          logger.info(`✅ Email fallback OTP sent to: ${user.email} (for phone ${identifier})`);
          return {
            method: 'email',
            message: `OTP Sent! Check your ${maskEmail(user.email)} (WhatsApp unavailable).`,
          };
        }
      } catch (emailErr) {
        logger.error(`❌ EMAIL FALLBACK ALSO FAILED for ${identifier}:`, emailErr.message);
      }

      // Dev: return console fallback instead of crashing
      if (isDev) {
        return { 
          method: 'dev_console', 
          message: `OTP logged in terminal (WhatsApp failed: ${whatsappErr.message}). Check if QR is scanned.` 
        };
      }

      // Production: throw descriptive error so admin knows WhatsApp is down
      const err = new Error('OTP delivery failed: WhatsApp is disconnected and no email is linked to this account. Please contact support or use your email to log in.');
      err.statusCode = 503;
      throw err;
    }
  }


  throw new Error('Invalid identifier: must be a valid email or 10-digit phone number');
};

// ─── Verify OTP ───────────────────────────────────────────────
const verifyOTP = async (rawIdentifier, otp, purpose = 'register', deleteAfter = true) => {
  const identifier = rawIdentifier.includes('@') ? rawIdentifier.toLowerCase().trim() : rawIdentifier.replace(/\D/g, '');
  
  // Primary lookup by identifier (phone or email as stored)
  let record = await OTP.findOne({ identifier, purpose });
  
  // Email fallback: if OTP was stored under user's email (WhatsApp was down), find it
  if (!record && !rawIdentifier.includes('@')) {
    try {
      const User = require('../models/User');
      const user = await User.findOne({ phone: identifier }).select('email');
      if (user?.email) {
        record = await OTP.findOne({ identifier: user.email, purpose });
        if (record) {
          return await _verifyRecord(record, otp, deleteAfter);
        }
      }
    } catch (_) { /* ignore lookup errors, fall through to not-found error */ }
  }

  if (!record) {
    const err = new Error('OTP not found or expired. Please request a new OTP.');
    err.statusCode = 400;
    throw err;
  }

  return await _verifyRecord(record, otp, deleteAfter);
};

// ─── Internal verify helper ───────────────────────────────────
const _verifyRecord = async (record, otp, deleteAfter) => {
  if (record.expiresAt < new Date()) {
    await OTP.deleteOne({ _id: record._id });
    const err = new Error('OTP has expired. Please request a new one.');
    err.statusCode = 400;
    throw err;
  }

  if (record.attempts >= 5) {
    const err = new Error('Too many incorrect attempts. Please request a new OTP.');
    err.statusCode = 400;
    throw err;
  }

  if (record.otp !== String(otp)) {
    await OTP.updateOne({ _id: record._id }, { $inc: { attempts: 1 } });
    const remaining = 5 - (record.attempts + 1);
    const err = new Error(`Incorrect OTP. ${remaining} attempts remaining.`);
    err.statusCode = 400;
    throw err;
  }

  if (deleteAfter) {
    await OTP.deleteOne({ _id: record._id });
  }
  return true;
};

// ─── Helpers ──────────────────────────────────────────────────
const maskEmail = (email) => {
  const [user, domain] = email.split('@');
  return `${user.slice(0, 2)}***@${domain}`;
};

const maskPhone = (phone) => {
  const clean = phone.replace(/\D/g, '');
  return `${clean.slice(0, 2)}****${clean.slice(-2)}`;
};

module.exports = { sendOTP, verifyOTP, generateOTP };
