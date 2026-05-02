const nodemailer = require('nodemailer');
const logger = require('../utils/logger');

const getTransporter = async () => {
  const user = process.env.EMAIL_USER;
  const pass = process.env.EMAIL_PASSWORD?.replace(/\s/g, '');
  const host = process.env.EMAIL_HOST || 'smtp-relay.brevo.com';
  const port = parseInt(process.env.EMAIL_PORT || '587');
  const secure = process.env.EMAIL_SECURE === 'true';

  if (!user || !pass) {
    logger.error('❌ EMAIL_USER or EMAIL_PASSWORD not set in environment');
    throw new Error('Brevo SMTP credentials not configured');
  }

  logger.info(`📧 Brevo SMTP: Connecting via ${host}:${port} as ${user}`);

  return nodemailer.createTransport({
    host: host,
    port: port,
    secure: secure,
    auth: {
      user: user,
      pass: pass
    },
    tls: {
      rejectUnauthorized: false
    },
    connectionTimeout: 15000,
    greetingTimeout: 10000,
    socketTimeout: 30000
  });
};

const verifyEmailConfig = async () => {
  try {
    logger.info('📧 Verifying Brevo SMTP configuration...');
    const transporter = await getTransporter();
    await transporter.verify();
    logger.info('✅ Brevo SMTP Ready: Connected successfully');
    return true;
  } catch (err) {
    logger.error(`❌ Brevo SMTP Error: ${err.message}`);
    return false;
  }
};

module.exports = { getTransporter, verifyEmailConfig };
