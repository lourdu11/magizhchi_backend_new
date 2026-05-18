const Settings = require('../models/Settings');
const logger = require('../utils/logger');

/**
 * Single recipient guard + Gmail SMTP dispatcher
 */
const dispatchEmail = async (mailOptions) => {
  const execId = Math.random().toString(36).substring(7).toUpperCase();

  // Basic check before handing over to the Global Gatekeeper in brevoApi.js
  if (!mailOptions.to || typeof mailOptions.to !== 'string') {
    logger.error(`❌ [${execId}] dispatchEmail BLOCKED: recipient missing or invalid type`);
    return;
  }

  // Ensure no CC/BCC leak at this level
  delete mailOptions.cc;
  delete mailOptions.bcc;

  try {
    const Settings = require('../models/Settings');
    const settings = await Settings.findOne().select('+notifications.email.password');
    
    if (settings?.notifications?.email?.host && settings?.notifications?.email?.user && settings?.notifications?.email?.password) {
      const nodemailer = require('nodemailer');
      const transporter = nodemailer.createTransport({
        host: settings.notifications.email.host,
        port: settings.notifications.email.port || 587,
        secure: settings.notifications.email.port === 465,
        auth: {
          user: settings.notifications.email.user,
          pass: settings.notifications.email.password
        }
      });
      
      logger.info(`📧 [${execId}] Dispatching via DB-Custom SMTP (${settings.notifications.email.host}) → TO: ${mailOptions.to}`);
      
      const fromField = mailOptions.from || `"${settings.store?.name || 'Magizhchi Garments'}" <${settings.notifications.email.user}>`;
      
      const result = await transporter.sendMail({
        from: fromField,
        to: mailOptions.to,
        subject: mailOptions.subject,
        text: mailOptions.text,
        html: mailOptions.html
      });
      
      logger.info(`✅ [${execId}] DB-Custom SMTP Dispatch Success! MessageId: ${result.messageId}`);
      return { success: true, message: 'Delivered via dynamic SMTP', messageId: result.messageId };
    }

    const { sendBrevoApi } = require('../utils/brevoApi');
    
    logger.info(`📧 [${execId}] Dispatching via Global Gatekeeper → TO: ${mailOptions.to} | SUBJECT: ${mailOptions.subject}`);
    
    const result = await sendBrevoApi(mailOptions);
    
    logger.info(`✅ [${execId}] Dispatch Complete [${execId}]`);
    return result;
  } catch (err) {
    logger.error(`🔥 [${execId}] Email Dispatch Error: ${err.message}`);
    throw err;
  }
};

const VALID_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const getAdminRecipient = async () => {
  // Always fetch fresh from DB — never use a cached value
  const settings = await Settings.findOne().lean();
  const rawEmail = settings?.notifications?.email?.alertEmail;

  if (!rawEmail || typeof rawEmail !== 'string' || !rawEmail.trim()) {
    logger.error('❌ [BLOCK] Admin Notification Email is not configured in Settings.');
    return null;
  }

  // Take only the FIRST token if someone accidentally saved multiple emails
  const adminEmail = rawEmail.trim().split(/[\s,;]+/)[0].toLowerCase();

  // Strict format validation — must be a proper single email
  if (!VALID_EMAIL_RE.test(adminEmail)) {
    logger.error(`❌ [BLOCK] Admin email "${adminEmail}" failed format validation. Fix it in Settings.`);
    return null;
  }

  logger.info(`🎯 [AUDIT] Admin recipient locked to: ${adminEmail}`);
  return adminEmail;
};

/**
 * Get FROM address — reads from .env so no hardcoded values
 * EMAIL_FROM can be: plain email OR "Name <email@domain.com>" format
 */
const getFromAddress = (storeName) => {
  const rawFrom = process.env.EMAIL_FROM || process.env.EMAIL_USER || '';
  const match = rawFrom.match(/<([^>]+)>/);
  const fromEmail = match ? match[1].trim() : rawFrom.trim();
  const displayName = storeName || 'Magizhchi Garments';
  return { from: `${displayName} <${fromEmail}>`, fromEmail };
};

/**
 * OTP Email
 */
const sendOTPEmail = async (email, otp, purpose = 'register') => {
  try {
    const settings = await Settings.findOne().lean();
    const storeName = settings?.store?.name || 'Magizhchi Garments';
    const sender = getFromAddress(storeName);
    if (!sender) return;

    const purposes = {
      register: { subject: 'Verify Your Account', title: 'Welcome!' },
      login: { subject: 'Login OTP', title: 'Login OTP' },
      password_reset: { subject: 'Password Reset OTP', title: 'Reset Password' }
    };
    const meta = purposes[purpose] || purposes.register;

    return await dispatchEmail({
      from: sender.from,
      to: email,
      subject: `${meta.subject} — ${storeName}`,
      html: `<h2>${meta.title}</h2><p>Your OTP is: <b>${otp}</b></p><p>Valid for 10 minutes.</p>`
    });
  } catch (err) {
    logger.error(`🔥 OTP Email Error: ${err.message}`);
    throw err;
  }
};

/**
 * Order Confirmation to Customer
 */
const sendOrderConfirmationEmail = async (order) => {
  try {
    const settings = await Settings.findOne().lean();
    const storeName = settings?.store?.name || 'Magizhchi Garments';
    const sender = getFromAddress(storeName);
    if (!sender) return;

    const customerEmail = order.guestDetails?.email
      || order.shippingAddress?.email
      || order.userId?.email;

    if (!customerEmail) {
      logger.error('❌ No customer email found for order confirmation');
      return;
    }

    const { orderConfirmationTemplate } = require('../utils/emailTemplates');

    return await dispatchEmail({
      from: sender.from,
      to: customerEmail,
      subject: `Order Confirmed #${order.orderNumber} — ${storeName}`,
      html: orderConfirmationTemplate(order, storeName)
    });
  } catch (err) {
    logger.error(`🔥 Order Confirmation Email Error: ${err.message}`);
  }
};

/**
 * Low Stock Alert to Admin
 */
const sendLowStockEmail = async (product) => {
  try {
    const adminEmail = await getAdminRecipient();
    if (!adminEmail) return;

    const settings = await Settings.findOne().lean();
    const storeName = settings?.store?.name || 'Magizhchi Garments';
    const sender = getFromAddress(storeName);
    if (!sender) return;

    const { lowStockTemplate } = require('../utils/lowStockAlert');

    return await dispatchEmail({
      from: `System Alert <${sender.fromEmail}>`,
      to: adminEmail,
      subject: `⚠️ LOW STOCK: ${product.name || product.productName}`,
      html: lowStockTemplate(product, storeName)
    });
  } catch (err) {
    logger.error(`🔥 Low Stock Email Error: ${err.message}`);
  }
};

/**
 * New Order Alert to Admin
 */
const sendAdminOrderNotificationEmail = async (order) => {
  try {
    const adminEmail = await getAdminRecipient();
    if (!adminEmail) return;

    const settings = await Settings.findOne().lean();
    const storeName = settings?.store?.name || 'Magizhchi Garments';
    const sender = getFromAddress(storeName);
    if (!sender) return;

    const { adminOrderTemplate } = require('../utils/emailTemplates');

    return await dispatchEmail({
      from: `Sales Notification <${sender.fromEmail}>`,
      to: adminEmail,
      subject: `🎉 New Order #${order.orderNumber}`,
      html: adminOrderTemplate(order, storeName)
    });
  } catch (err) {
    logger.error(`🔥 Admin Order Email Error: ${err.message}`);
    throw err;
  }
};

/**
 * Contact Alert to Admin
 */
const sendAdminContactNotificationEmail = async (contactData) => {
  try {
    const adminEmail = await getAdminRecipient();
    if (!adminEmail) return;

    const settings = await Settings.findOne().lean();
    const storeName = settings?.store?.name || 'Magizhchi Garments';
    const sender = getFromAddress(storeName);
    if (!sender) return;

    const body = `
      <h2>New Inquiry Received</h2>
      <div style="background:#f3f4f6;padding:20px;border-radius:8px;margin:20px 0">
        <p><b>Name:</b> ${contactData.name}<br/>
        <b>Email:</b> ${contactData.email}<br/>
        <b>Phone:</b> ${contactData.phone}</p>
        <p><b>Subject:</b> ${contactData.subject}</p>
      </div>
      <p><b>Message:</b></p>
      <div style="padding:15px;border-left:4px solid #4f46e5;background:#fafafa">
        ${contactData.message}
      </div>
    `;

    return await dispatchEmail({
      from: `Contact Form <${sender.fromEmail}>`,
      to: adminEmail,
      subject: `📩 New Message: ${contactData.subject}`,
      html: body
    });
  } catch (err) {
    logger.error(`🔥 Admin Contact Email Error: ${err.message}`);
    throw err;
  }
};

/**
 * Order Cancellation Alert to Admin
 */
const sendAdminOrderCancellationEmail = async (order) => {
  try {
    const adminEmail = await getAdminRecipient();
    if (!adminEmail) return;

    const settings = await Settings.findOne().lean();
    const storeName = settings?.store?.name || 'Magizhchi Garments';
    const sender = getFromAddress(storeName);
    if (!sender) return;

    return await dispatchEmail({
      from: `Cancellation Alert <${sender.fromEmail}>`,
      to: adminEmail,
      subject: `❌ Order Cancelled #${order.orderNumber}`,
      html: `<p>Order <b>#${order.orderNumber}</b> has been cancelled.</p>`
    });
  } catch (err) {
    logger.error(`🔥 Admin Cancellation Email Error: ${err.message}`);
  }
};

/**
 * Get email settings helper
 */
const getEmailSettings = async () => {
  const settings = await Settings.findOne().lean();
  const fromEmail = process.env.EMAIL_USER;
  const storeName = settings?.store?.name || 'Magizhchi Garments';
  return {
    from: `${storeName} <${fromEmail}>`,
    fromEmail,
    storeName
  };
};

/**
 * Bill Receipt to Customer (Offline/POS)
 */
const sendBillReceiptEmail = async (bill) => {
  try {
    const settings = await Settings.findOne().lean();
    const storeName = settings?.store?.name || 'Magizhchi Garments';
    const sender = getFromAddress(storeName);
    if (!sender) return;

    const customerEmail = bill.customerDetails?.email;
    if (!customerEmail) {
      logger.error('❌ No customer email found for bill receipt');
      return;
    }

    const { billReceiptTemplate } = require('../utils/emailTemplates');

    return await dispatchEmail({
      from: sender.from,
      to: customerEmail,
      subject: `Invoice #${bill.billNumber} — ${storeName}`,
      html: billReceiptTemplate(bill, storeName)
    });
  } catch (err) {
    logger.error(`🔥 Bill Receipt Email Error: ${err.message}`);
  }
};

module.exports = {
  sendOTPEmail,
  sendOrderConfirmationEmail,
  sendBillReceiptEmail,
  sendLowStockEmail,
  sendAdminOrderNotificationEmail,
  sendAdminContactNotificationEmail,
  sendAdminOrderCancellationEmail,
  getEmailSettings
};
