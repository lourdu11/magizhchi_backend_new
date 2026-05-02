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
    
    // Force use of verified sender for production stability
    const fromEmail = 'lncoderise@gmail.com'; 
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
      replyTo: fromEmail,
      html 
    };

    if (isBrevo) {
      logger.info(`📧 Email: Using Brevo API for ${email} (From: ${fromEmail})`);
      const { sendBrevoApi } = require('../utils/brevoApi');
      return await sendBrevoApi(mailOptions);
    } else {
      logger.info(`📧 Email: Using SMTP for ${email} (Host: ${process.env.EMAIL_HOST || 'default'})`);
      const transporter = await getTransporter();
      return await transporter.sendMail(mailOptions);
    }
  } catch (err) {
    logger.error(`🔥 Email Service Error for ${email}: ${err.stack || err.message}`);
    throw err;
  }
};

/**
 * Sends Order Confirmation to Customer
 */
const sendOrderConfirmationEmail = async (order) => {
  try {
    const settings = await Settings.findOne().lean();
    const storeName = settings?.store?.name || 'Magizhchi Garments';
    const { orderConfirmationTemplate } = require('../utils/emailTemplates');
    
    const html = orderConfirmationTemplate(order, storeName);
    const mailOptions = {
      from: `${storeName} <lncoderise@gmail.com>`,
      fromEmail: 'lncoderise@gmail.com',
      fromName: storeName,
      to: order.guestDetails?.email || order.shippingAddress?.email || order.userId?.email,
      subject: `Order Confirmed #${order.orderNumber} — ${storeName}`,
      replyTo: 'lncoderise@gmail.com',
      html
    };

    const { sendBrevoApi } = require('../utils/brevoApi');
    return await sendBrevoApi(mailOptions);
  } catch (err) {
    logger.error(`🔥 Order Confirmation Email Error: ${err.message}`);
  }
};

/**
 * Sends Low Stock Alert to Admin
 */
const sendLowStockEmail = async (product, overrideRecipient = null) => {
  try {
    const settings = await Settings.findOne().lean();
    const adminEmail = overrideRecipient || settings?.notifications?.email?.alertEmail || 'lncoderise@gmail.com';
    const storeName = settings?.store?.name || 'Magizhchi Garments';
    const { lowStockTemplate } = require('../utils/emailTemplates');

    const html = lowStockTemplate(product, storeName);
    const mailOptions = {
      from: `System Alert <lncoderise@gmail.com>`,
      to: adminEmail,
      subject: `⚠️ LOW STOCK: ${product.name}`,
      html
    };

    const { sendBrevoApi } = require('../utils/brevoApi');
    return await sendBrevoApi(mailOptions);
  } catch (err) {
    logger.error(`🔥 Low Stock Email Error: ${err.message}`);
  }
};

/**
 * Sends New Order Alert to Admin
 */
const sendAdminOrderNotificationEmail = async (order) => {
  try {
    const settings = await Settings.findOne().lean();
    const adminEmail = settings?.notifications?.email?.alertEmail || 'lncoderise@gmail.com';
    const storeName = settings?.store?.name || 'Magizhchi Garments';
    const { adminOrderTemplate } = require('../utils/emailTemplates');

    const html = adminOrderTemplate(order, storeName);
    const mailOptions = {
      from: `Sales Notification <lncoderise@gmail.com>`,
      to: adminEmail,
      subject: `🎉 New Order #${order.orderNumber}`,
      html
    };

    const { sendBrevoApi } = require('../utils/brevoApi');
    return await sendBrevoApi(mailOptions);
  } catch (err) {
    logger.error(`🔥 Admin Order Email Error: ${err.message}`);
  }
};

/**
 * Sends Contact Form Notification to Admin
 */
const sendAdminContactNotificationEmail = async (contactData) => {
  try {
    const settings = await Settings.findOne().lean();
    const adminEmail = settings?.notifications?.email?.alertEmail || 'lncoderise@gmail.com';
    const { generateEmailHTML } = require('../utils/emailTemplates');

    const body = `
      <h2>New Inquiry Received</h2>
      <p>A customer has sent a message via the contact form:</p>
      <div style="background-color:#f3f4f6; padding:20px; border-radius:8px; margin:20px 0">
        <p><b>Name:</b> ${contactData.name}<br/>
        <b>Email:</b> ${contactData.email}<br/>
        <b>Subject:</b> ${contactData.subject || 'N/A'}<br/>
        <b>Message:</b><br/>${contactData.message}</p>
      </div>
    `;

    const html = generateEmailHTML({
      title: 'New Contact Inquiry',
      body,
      storeName: settings?.store?.name || 'Magizhchi Garments'
    });

    const mailOptions = {
      from: `Contact Form <lncoderise@gmail.com>`,
      to: adminEmail,
      subject: `📩 New Contact Inquiry: ${contactData.subject || 'Support'}`,
      html
    };

    const { sendBrevoApi } = require('../utils/brevoApi');
    return await sendBrevoApi(mailOptions);
  } catch (err) {
    logger.error(`🔥 Contact Email Error: ${err.message}`);
  }
};

const sendAdminOrderCancellationEmail = async () => {};

module.exports = { 
  sendOTPEmail, 
  sendOrderConfirmationEmail, 
  sendLowStockEmail, 
  sendAdminOrderNotificationEmail,
  sendAdminContactNotificationEmail,
  sendAdminOrderCancellationEmail
};
