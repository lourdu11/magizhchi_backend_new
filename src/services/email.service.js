const Settings = require('../models/Settings');
const logger = require('../utils/logger');

/**
 * Single recipient guard + Gmail SMTP dispatcher
 */
const dispatchEmail = async (mailOptions) => {
  // Strict single recipient guard
  if (!mailOptions.to || typeof mailOptions.to !== 'string') {
    logger.error('❌ dispatchEmail blocked: recipient missing or invalid');
    return;
  }
  if (mailOptions.to.includes(',') || mailOptions.to.includes(';')) {
    logger.error(`❌ dispatchEmail BLOCKED — multiple recipients: ${mailOptions.to}`);
    return;
  }

  try {
    // Always use Brevo API — no SMTP
    const { sendBrevoApi } = require('../utils/brevoApi');
    logger.info(`📧 Brevo API dispatch → TO: ${mailOptions.to}`);
    return await sendBrevoApi(mailOptions);
  } catch (err) {
    logger.error(`🔥 Email Dispatch Error: ${err.message}`);
    throw err;
  }
};

/**
 * Single source of truth for admin recipient
 * NO fallbacks — if not set, returns null and blocks send
 */
const getAdminRecipient = async () => {
  const settings = await Settings.findOne().lean();
  const alertEmail = settings?.notifications?.email?.alertEmail?.trim().toLowerCase();

  if (!alertEmail) {
    logger.error('❌ No Admin Notification Email configured in Settings → Notifications');
    return null;
  }

  logger.info(`✅ Admin recipient resolved → ${alertEmail}`);
  return alertEmail;
};

/**
 * Get FROM address — always from environment
 */
const getFromAddress = (storeName) => {
  const fromEmail = process.env.EMAIL_USER;
  if (!fromEmail) {
    logger.error('❌ EMAIL_USER not set in environment');
    return null;
  }
  return { from: `${storeName} <${fromEmail}>`, fromEmail };
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

module.exports = {
  sendOTPEmail,
  sendOrderConfirmationEmail,
  sendLowStockEmail,
  sendAdminOrderNotificationEmail,
  sendAdminContactNotificationEmail,
  sendAdminOrderCancellationEmail,
  getEmailSettings
};
