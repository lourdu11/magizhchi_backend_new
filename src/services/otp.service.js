const OTP = require('../models/OTP');
const logger = require('../utils/logger');

// ─── Generate 6-digit OTP ─────────────────────────────────────
const generateOTP = () => String(Math.floor(100000 + Math.random() * 900000));

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
  await OTP.findOneAndDelete({ identifier, purpose });
  await OTP.create({
    identifier,
    purpose,
    otp,
    expiresAt: new Date(Date.now() + expireMinutes * 60 * 1000),
  });

  if (process.env.NODE_ENV !== 'production') {
    console.log('DEBUG: Flow Detection -> isEmail:', isEmailId, 'isPhone:', isPhoneId, 'normalized:', identifier);
    
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
      return { method: 'email', message: `OTP sent to ${maskEmail(identifier)}` };
    } catch (err) {
      logger.error(`❌ EMAIL OTP SEND ERROR to ${identifier}:`, err.message);
      if (isDev) {
        logger.warn(`Email send failed — This is common in Dev if SMTP is not set. OTP is printed in terminal above.`);
        return { 
          method: 'dev_console', 
          message: `OTP logged in terminal (Email failed: ${err.message}). Check your .env SMTP settings.` 
        };
      }
      throw err;
    }
  }

  // ── Phone → Your WhatsApp ──────────────────────────────────
  if (isPhoneId) {
    try {
      await sendWhatsAppOTP_Own(identifier, otp, purpose);
      return { method: 'whatsapp', message: `OTP sent to WhatsApp ${maskPhone(identifier)}` };
    } catch (err) {
      logger.error(`❌ WHATSAPP OTP SEND ERROR to ${identifier}:`, err.message);
      if (isDev) {
        logger.warn(`WhatsApp send failed — Ensure QR is scanned. Falling back to terminal log.`);
        return { 
          method: 'dev_console', 
          message: `OTP logged in terminal (WhatsApp failed: ${err.message}). Check if QR is scanned.` 
        };
      }
      throw err;
    }
  }


  throw new Error('Invalid identifier: must be a valid email or 10-digit phone number');
};

// ─── Verify OTP ───────────────────────────────────────────────
const verifyOTP = async (rawIdentifier, otp, purpose = 'register', deleteAfter = true) => {
  const identifier = rawIdentifier.includes('@') ? rawIdentifier.toLowerCase().trim() : rawIdentifier.replace(/\D/g, '');
  const record = await OTP.findOne({ identifier, purpose });

  if (!record) {
    const err = new Error('OTP not found or expired. Please request a new OTP.');
    err.statusCode = 400;
    throw err;
  }

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
