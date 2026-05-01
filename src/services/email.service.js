const { getTransporter } = require('../config/email');
const logger = require('../utils/logger');
const Settings = require('../models/Settings');

/**
 * Sends OTP Email
 */
const sendOTPEmail = async (email, otp, purpose = 'register') => {
  try {
    const settings = await Settings.findOne().lean();
    const storeName = settings?.store?.name || process.env.STORE_NAME || 'Magizhchi Garments';
    const fromEmail = settings?.store?.email || process.env.EMAIL_FROM || process.env.EMAIL_USER || 'info@magizhchi.com';
    const from = `${storeName} <${fromEmail}>`;

    const purposes = {
      register: { subject: 'Verify Your Account', title: 'Welcome!', action: 'Verify Email' },
      login: { subject: 'Login OTP', title: 'Login OTP', action: 'Login' },
      password_reset: { subject: 'Password Reset OTP', title: 'Reset Password', action: 'Reset Password' }
    };
    const meta = purposes[purpose] || purposes.register;

    const html = `<h2>${meta.title}</h2><p>Your OTP is: <b>${otp}</b></p>`;
    
    const apiPass = (process.env.EMAIL_PASSWORD || '').trim();
    const isBrevo = apiPass.startsWith('xkeysib-') || apiPass.startsWith('xsmtpsib-') || process.env.EMAIL_HOST === 'api.brevo.com';

    const mailOptions = { 
      from, 
      fromEmail, 
      fromName: storeName,
      to: email, 
      subject: `${meta.subject} — ${storeName}`, 
      html 
    };

    if (isBrevo) {
      logger.info('📧 Using Brevo API...');
      const { sendBrevoApi } = require('../utils/brevoApi');
      return await sendBrevoApi(mailOptions);
    } else {
      logger.info('📧 Using SMTP...');
      const transporter = await getTransporter();
      return await transporter.sendMail(mailOptions);
    }
  } catch (err) {
    logger.error('❌ Email Service Error:', err.message);
    throw err;
  }
};

/**
 * Placeholder for other emails
 */
const sendOrderConfirmationEmail = async () => {};
const sendLowStockEmail = async () => {};
const sendAdminOrderNotificationEmail = async () => {};
const sendAdminContactNotificationEmail = async () => {};
const sendAdminOrderCancellationEmail = async () => {};

module.exports = { 
  sendOTPEmail, 
  sendOrderConfirmationEmail, 
  sendLowStockEmail, 
  sendAdminOrderNotificationEmail,
  sendAdminContactNotificationEmail,
  sendAdminOrderCancellationEmail
};
