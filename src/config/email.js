const nodemailer = require('nodemailer');
const logger = require('../utils/logger');
const Settings = require('../models/Settings');

/**
 * Dynamically creates a transporter based on the latest database settings.
 * Falls back to environment variables or placeholder settings if DB is unconfigured.
 */
const getTransporter = async () => {
  try {
    const settings = await Settings.findOne().lean();
    const config = settings?.notifications?.email;

    // Use DB settings if fully configured (host, user, and non-empty password)
    if (config?.host && config?.user && config?.password && config.password.trim() !== '') {
      return nodemailer.createTransport({
        host: config.host,
        port: parseInt(config.port || '587'),
        secure: parseInt(config.port) === 465,
        auth: {
          user: config.user,
          pass: config.password.replace(/\s/g, ''), // Strip spaces for Gmail App Passwords
        },
      });
    }

    // Fallback to environment variables
    const envUser = process.env.EMAIL_USER;
    const envPass = process.env.EMAIL_PASSWORD;
    const isPlaceholder = !envUser || envUser.includes('placeholder') || envUser === 'your_gmail@gmail.com';

    if (isPlaceholder && process.env.NODE_ENV !== 'production') {
      return nodemailer.createTransport({
        host: 'smtp.ethereal.email',
        port: 587,
        auth: { user: 'dev@ethereal.email', pass: 'devpass' },
      });
    }

    return nodemailer.createTransport({
      host: process.env.EMAIL_HOST || 'smtp.gmail.com',
      port: parseInt(process.env.EMAIL_PORT || '587'),
      secure: process.env.EMAIL_SECURE === 'true' || process.env.EMAIL_PORT === '465',
      auth: {
        user: envUser,
        pass: envPass ? envPass.replace(/\s/g, '') : '', // Strip spaces for Gmail App Passwords
      },
    });
  } catch (err) {
    logger.error('Error creating email transporter:', err);
    throw err;
  }
};

const verifyEmailConfig = async () => {
  try {
    const transporter = await getTransporter();
    await transporter.verify();
    logger.info('✅ Email Ready: [SMTP Connected]');
    return true;
  } catch (err) {
    logger.error('❌ Email Error: SMTP configuration invalid or unreachable.', err.message);
    return false;
  }
};

module.exports = { getTransporter, verifyEmailConfig };
