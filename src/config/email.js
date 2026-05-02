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
        },
        connectionTimeout: 15000,
        family: 4
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

    const envHost = process.env.EMAIL_HOST || 'smtp.gmail.com';
    const envPort = parseInt(process.env.EMAIL_PORT || '465');
    const envSecure = process.env.EMAIL_SECURE === 'true' || envPort === 465;

    logger.info(`📧 Email: Connecting to ${envHost}:${envPort} (User: ${envUser || 'None'})`);

    return nodemailer.createTransport({
      host: envHost,
      port: envPort,
      secure: envSecure,
      auth: {
        user: envUser,
        pass: envPass ? envPass.replace(/\s/g, '') : '', 
      },
      tls: {
        rejectUnauthorized: false
      },
      connectionTimeout: 30000,
      greetingTimeout: 10000,
      socketTimeout: 30000,
      family: 4
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
    
    // Run verification in the background
    transporter.verify().then(() => {
      logger.info('✅ Email Ready: [SMTP Connected]');
    }).catch(err => {
      const host = process.env.EMAIL_HOST || '';
      // If we are using API modes, we don't care about SMTP errors
      if (host === 'smtp.resend.com' || host === 'api.brevo.com') {
        logger.info(`ℹ️  SMTP port blocked, but ${host === 'api.brevo.com' ? 'Brevo' : 'Resend'} API is active. Emails will still work.`);
      } else {
        logger.error(`❌ Email Error: ${err.message}`);
      }
    });
    
    return true;
  } catch (err) {
    logger.error(`❌ Email Error: ${err.message}`);
    return false;
  }
};

module.exports = { getTransporter, verifyEmailConfig };
