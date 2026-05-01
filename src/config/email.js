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
      logger.info(`📧 Email: Using Database settings (Host: ${config.host})`);
      return nodemailer.createTransport({
        host: config.host,
        port: parseInt(config.port || '587'),
        secure: parseInt(config.port) === 465,
        auth: {
          user: config.user,
          pass: config.password.replace(/\s/g, ''), 
        },
        tls: {
          rejectUnauthorized: false
        }
      });
    }

    // Fallback to environment variables
    const envUser = process.env.EMAIL_USER;
    const envPass = process.env.EMAIL_PASSWORD;
    logger.info(`📧 Email: Using Environment settings (User: ${envUser || 'None'})`);
    
    const isPlaceholder = !envUser || envUser.includes('placeholder') || envUser === 'your_gmail@gmail.com';

    if (isPlaceholder && process.env.NODE_ENV !== 'production') {
      logger.info('📧 Email: Using Ethereal (Dev) fallback');
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
        pass: envPass ? envPass.replace(/\s/g, '') : '', 
      },
      tls: {
        rejectUnauthorized: false
      }
    });
  } catch (err) {
    logger.error('Error creating email transporter:', err);
    throw err;
  }
};

const verifyEmailConfig = async () => {
  try {
    logger.info('📧 Email: Verifying SMTP configuration...');
    const transporter = await getTransporter();
    
    // Set a timeout for verification to avoid hanging
    const timeout = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('SMTP Verification Timeout (30s)')), 30000)
    );
    
    await Promise.race([transporter.verify(), timeout]);
    
    logger.info('✅ Email Ready: [SMTP Connected]');
    return true;
  } catch (err) {
    logger.error(`❌ Email Error: ${err.message}`);
    return false;
  }
};

module.exports = { getTransporter, verifyEmailConfig };
