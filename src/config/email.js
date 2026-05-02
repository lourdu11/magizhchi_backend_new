const nodemailer = require('nodemailer');
const logger = require('../utils/logger');

const getTransporter = async () => {
  const user = process.env.EMAIL_USER;
  const pass = process.env.EMAIL_PASSWORD?.replace(/\s/g, '');

  if (!user || !pass) {
    logger.error('❌ EMAIL_USER or EMAIL_PASSWORD not set in environment');
    throw new Error('Gmail SMTP credentials not configured');
  }

  logger.info(`📧 Gmail SMTP: Connecting as ${user}`);

  return nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true, // Use SSL
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
    logger.info('📧 Verifying Gmail SMTP configuration...');
    const transporter = await getTransporter();
    await transporter.verify();
    logger.info('✅ Gmail SMTP Ready: Connected successfully');
    return true;
  } catch (err) {
    logger.error(`❌ Gmail SMTP Error: ${err.message}`);
    return false;
  }
};

module.exports = { getTransporter, verifyEmailConfig };
