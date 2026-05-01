const { getTransporter } = require('../config/email');
const logger = require('../utils/logger');
const Settings = require('../models/Settings');

/**
 * Universal Email Sender Helper
 * Handles dynamic routing between SMTP and HTTP APIs (Resend/Brevo)
 */
const sendUniversalEmail = async (mailOptions) => {
  const { storeName, from } = await getEmailSettings();
  const apiPass = (process.env.EMAIL_PASSWORD || '').trim();
  
  // Detection logic based on API Key prefix
  const isResend = apiPass.startsWith('re_');
  const isBrevo = apiPass.startsWith('xkeysib-') || apiPass.startsWith('xsmtpsib-') || process.env.EMAIL_HOST === 'api.brevo.com';

  // Prepare standard options
  const finalOptions = {
    ...mailOptions,
    from: mailOptions.from || from,
    fromEmail: (mailOptions.from || from).match(/<(.+)>|(\S+@\S+)/)?.[1] || (mailOptions.from || from),
    fromName: mailOptions.fromName || storeName,
  };

  try {
    if (isResend) {
      logger.info(`📧 Resend API: Dispatching [${finalOptions.subject}] to ${finalOptions.to}`);
      const { sendResendApi } = require('../utils/resendApi');
      return await sendResendApi(finalOptions);
    } 
    
    if (isBrevo) {
      logger.info(`📧 Brevo API: Dispatching [${finalOptions.subject}] to ${finalOptions.to}`);
      const { sendBrevoApi } = require('../utils/brevoApi');
      return await sendBrevoApi(finalOptions);
    }

    // Default: SMTP
    logger.info(`📧 SMTP: Dispatching [${finalOptions.subject}] to ${finalOptions.to}`);
    const transporter = await getTransporter();
    return await transporter.sendMail(finalOptions);

  } catch (err) {
    logger.error(`❌ Email Failed: ${err.message}`);
    
    // Auto-fallback if SMTP failed but we have an API key
    if (!isResend && !isBrevo) {
      if (apiPass.startsWith('re_')) {
        logger.info('🔄 Fallback: Attempting Resend API...');
        const { sendResendApi } = require('../utils/resendApi');
        return await sendResendApi(finalOptions).catch(e => logger.error(`Fallback failed (Resend): ${e.message}`));
      } 
      if (apiPass.startsWith('xkeysib-') || apiPass.startsWith('xsmtpsib-')) {
        logger.info('🔄 Fallback: Attempting Brevo API...');
        const { sendBrevoApi } = require('../utils/brevoApi');
        return await sendBrevoApi(finalOptions).catch(e => logger.error(`Fallback failed (Brevo): ${e.message}`));
      }
    }
    throw err;
  }
};

// Helper to get from address and store name
const getEmailSettings = async () => {
  const settings = await Settings.findOne().lean();
  const storeName = settings?.store?.name || process.env.STORE_NAME || 'Magizhchi Garments';
  const fromEmail = settings?.store?.email || process.env.EMAIL_USER || 'noreply@magizhchi.com';
  const from = `${storeName} <${fromEmail}>`;
  return { storeName, from };
};

// ─── OTP Email ────────────────────────────────────────────────
const sendOTPEmail = async (email, otp, purpose = 'register') => {
  const { storeName } = await getEmailSettings();
  const purposes = {
    register: { subject: 'Verify Your Account', title: 'Welcome! Verify your email', action: 'Complete Registration' },
    login: { subject: 'Login OTP', title: 'Your login OTP', action: 'Login to Account' },
    password_reset: { subject: 'Password Reset OTP', title: 'Reset your password', action: 'Reset Password' },
    verify_email: { subject: 'Verify Your Email', title: 'Email Verification', action: 'Verify Email' },
    verify_phone: { subject: 'Verify Your Phone', title: 'Phone Verification', action: 'Verify Phone' },
  };

  const meta = purposes[purpose] || purposes.register;
  const expireMin = parseInt(process.env.OTP_EXPIRE_MINUTES || '10');

  const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f5f5f5;font-family:sans-serif;">
  <table width="100%" style="background:#f5f5f5;padding:30px 0;"><tr><td align="center">
  <table width="560" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.08);">
    <tr><td style="background:#1A1A1A;padding:32px 40px;text-align:center;">
      <div style="font-size:26px;font-weight:bold;color:#D4AF37;letter-spacing:6px;">MAGIZHCHI</div>
    </td></tr>
    <tr><td style="padding:40px;">
      <h2 style="color:#1A1A1A;">${meta.title}</h2>
      <p style="color:#666;">Use the OTP below to ${meta.action.toLowerCase()}. Code expires in ${expireMin} minutes.</p>
      <div style="background:#f8f4e8;border:2px solid #D4AF37;border-radius:10px;padding:24px;text-align:center;font-size:42px;font-weight:bold;letter-spacing:10px;">${otp}</div>
    </td></tr>
  </table></td></tr></table></body></html>`;

  await sendUniversalEmail({
    to: email,
    subject: `${meta.subject} — ${storeName}`,
    html,
    text: `Your OTP for ${meta.action} is: ${otp}`
  });
};

// ─── Order Confirmation Email ─────────────────────────────────
const sendOrderConfirmationEmail = async (email, order) => {
  const { storeName } = await getEmailSettings();
  const itemsHtml = order.items.map(item => `<li>${item.productName} x ${item.quantity}</li>`).join('');

  const html = `<h1>Order Confirmed!</h1><p>Order #${order.orderNumber}</p><ul>${itemsHtml}</ul>`;

  await sendUniversalEmail({
    to: email,
    subject: `Order Confirmed #${order.orderNumber} — ${storeName}`,
    html
  });
};

// ─── Low Stock Alert Email ─────────────────────────────────────
const sendLowStockEmail = async (email, item, currentStock) => {
  const { storeName } = await getEmailSettings();
  const html = `<h2>Low Stock Alert</h2><p>${item.productName} is low: ${currentStock} left.</p>`;

  await sendUniversalEmail({
    to: email,
    subject: `🚨 Low Stock Alert: ${item.productName} — ${storeName}`,
    html
  });
};

// ─── Admin Notifications ──────────────────────────────────────
const getAdminRecipients = async () => {
  const settings = await Settings.findOne().lean();
  const alertEmail = settings?.notifications?.email?.alertEmail;
  const storeEmail = settings?.store?.email || process.env.EMAIL_USER;
  return [...new Set([alertEmail, storeEmail].filter(Boolean))].join(', ');
};

const sendAdminOrderNotificationEmail = async (order) => {
  const recipients = await getAdminRecipients();
  if (!recipients) return;
  const { storeName } = await getEmailSettings();
  const html = `<h2>New Order #${order.orderNumber}</h2><p>Customer: ${order.shippingAddress?.name}</p>`;

  await sendUniversalEmail({
    to: recipients,
    subject: `🛍️ NEW ORDER: #${order.orderNumber} — ${storeName}`,
    html
  });
};

const sendAdminContactNotificationEmail = async (contact) => {
  const recipients = await getAdminRecipients();
  if (!recipients) return;
  const { storeName } = await getEmailSettings();
  const html = `<h2>New Contact Inquiry</h2><p>From: ${contact.name}</p><p>Message: ${contact.message}</p>`;

  await sendUniversalEmail({
    to: recipients,
    subject: `📩 NEW CONTACT: ${contact.subject || 'Inquiry'} — ${storeName}`,
    html
  });
};

const sendAdminOrderCancellationEmail = async (order, reason) => {
  const recipients = await getAdminRecipients();
  if (!recipients) return;
  const { storeName } = await getEmailSettings();
  const html = `<h2>Order Cancelled #${order.orderNumber}</h2><p>Reason: ${reason}</p>`;

  await sendUniversalEmail({
    to: recipients,
    subject: `🚫 ORDER CANCELLED: #${order.orderNumber} — ${storeName}`,
    html
  });
};

module.exports = { 
  sendOTPEmail, 
  sendOrderConfirmationEmail, 
  sendLowStockEmail, 
  sendAdminOrderNotificationEmail,
  sendAdminContactNotificationEmail,
  sendAdminOrderCancellationEmail
};
