/**
 * Internal helper to dispatch email using the best available method
 */
const dispatchEmail = async (mailOptions) => {
  try {
    const settings = await Settings.findOne().lean();
    const dbEmail = settings?.notifications?.email;
    
    // Check if we should use Brevo API
    const brevoApiKey = process.env.BREVO_API_KEY;
    const smtpPassword = (dbEmail?.password || process.env.EMAIL_PASSWORD || '').trim();
    
    // Auto-detect Brevo (API Key in password or explicit BREVO_API_KEY env)
    const isBrevo = 
      brevoApiKey || 
      smtpPassword.startsWith('xkeysib-') || 
      process.env.EMAIL_HOST === 'api.brevo.com' ||
      (dbEmail?.host === 'smtp-relay.brevo.com');

    if (isBrevo) {
      const { sendBrevoApi } = require('../utils/brevoApi');
      try {
        logger.info(`📧 Email: Dispatching via Brevo API to ${mailOptions.to}`);
        return await sendBrevoApi(mailOptions);
      } catch (err) {
        logger.warn(`⚠️ Brevo API Failed: ${err.message}. Falling back to SMTP...`);
      }
    }

    // SMTP Fallback
    logger.info(`📧 Email: Dispatching via SMTP to ${mailOptions.to}`);
    const { getTransporter } = require('../config/email');
    const transporter = await getTransporter();
    return await transporter.sendMail(mailOptions);
  } catch (err) {
    logger.error(`🔥 Email Dispatch Error: ${err.message}`);
    throw err;
  }
};

/**
 * Helper to get the most current Admin Alert Email at runtime.
 * NO FALLBACK — if not configured, returns null and skips sending.
 */
const getAdminRecipient = async () => {
  const settings = await Settings.findOne().lean();
  const alertEmail = settings?.notifications?.email?.alertEmail;

  if (!alertEmail || alertEmail.trim() === '') {
    logger.error('❌ CRITICAL: No Admin Notification Email configured in settings. Email not sent.');
    return null;
  }

  return alertEmail.trim().toLowerCase();
};

/**
 * Sends OTP Email
 */
const sendOTPEmail = async (email, otp, purpose = 'register') => {
  try {
    const settings = await Settings.findOne().lean();
    const storeName = settings?.store?.name || process.env.STORE_NAME || 'Magizhchi Garments';
    const fromEmail = settings?.notifications?.email?.user || process.env.EMAIL_FROM; 

    if (!fromEmail) {
      logger.error('❌ No FROM email configured. Cannot send OTP email.');
      return;
    }

    const from = `${storeName} <${fromEmail}>`;

    const purposes = {
      register: { subject: 'Verify Your Account', title: 'Welcome!', action: 'Verify Email' },
      login: { subject: 'Login OTP', title: 'Login OTP', action: 'Login' },
      password_reset: { subject: 'Password Reset OTP', title: 'Reset Password', action: 'Reset Password' }
    };
    const meta = purposes[purpose] || purposes.register;

    return await dispatchEmail({ 
      from, 
      fromEmail, 
      fromName: storeName,
      to: email, 
      subject: `${meta.subject} — ${storeName}`, 
      html: `<h2>${meta.title}</h2><p>Your OTP is: <b>${otp}</b></p>`
    });
  } catch (err) {
    logger.error(`🔥 OTP Email Error: ${err.message}`);
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
    
    const fromEmail = settings?.notifications?.email?.user || process.env.EMAIL_FROM;
    
    if (!fromEmail) {
      logger.error('❌ No FROM email configured. Cannot send order confirmation.');
      return;
    }

    const from = `${storeName} <${fromEmail}>`;
    
    return await dispatchEmail({
      from,
      fromEmail,
      fromName: storeName,
      to: order.guestDetails?.email || order.shippingAddress?.email || order.userId?.email,
      subject: `Order Confirmed #${order.orderNumber} — ${storeName}`,
      html: orderConfirmationTemplate(order, storeName)
    });
  } catch (err) {
    logger.error(`🔥 Order Confirmation Email Error: ${err.message}`);
  }
};

/**
 * Sends Low Stock Alert to Admin
 */
const sendLowStockEmail = async (product, overrideRecipient = null) => {
  try {
    const adminEmail = overrideRecipient || await getAdminRecipient();
    if (!adminEmail) return;

    const settings = await Settings.findOne().lean();
    const storeName = settings?.store?.name || 'Magizhchi Garments';
    const { lowStockTemplate } = require('../utils/lowStockAlert');

    const fromEmail = settings?.notifications?.email?.user || process.env.EMAIL_FROM;

    if (!fromEmail) {
      logger.error('❌ No FROM email configured. Cannot send low stock alert.');
      return;
    }

    return await dispatchEmail({
      from: `System Alert <${fromEmail}>`,
      fromEmail,
      to: adminEmail,
      subject: `⚠️ LOW STOCK: ${product.name}`,
      html: lowStockTemplate(product, storeName)
    });
  } catch (err) {
    logger.error(`🔥 Low Stock Email Error: ${err.message}`);
  }
};

/**
 * Sends New Order Alert to Admin
 */
const sendAdminOrderNotificationEmail = async (order) => {
  try {
    const adminEmail = await getAdminRecipient();
    if (!adminEmail) return;

    const settings = await Settings.findOne().lean();
    const storeName = settings?.store?.name || 'Magizhchi Garments';
    const { adminOrderTemplate } = require('../utils/emailTemplates');

    const fromEmail = settings?.notifications?.email?.user || process.env.EMAIL_FROM;

    if (!fromEmail) {
      logger.error('❌ No FROM email configured. Cannot send admin order notification.');
      return;
    }

    return await dispatchEmail({
      from: `Sales Notification <${fromEmail}>`,
      fromEmail,
      to: adminEmail,
      subject: `🎉 New Order #${order.orderNumber}`,
      html: adminOrderTemplate(order, storeName)
    });
  } catch (err) {
    logger.error(`🔥 Admin Order Email Error: ${err.message}`);
  }
};

/**
 * Sends Contact Form Notification to Admin
 */
const sendAdminContactNotificationEmail = async (contactData) => {
  try {
    const adminEmail = await getAdminRecipient();
    if (!adminEmail) return;

    const settings = await Settings.findOne().lean();
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

    const fromEmail = settings?.notifications?.email?.user || process.env.EMAIL_FROM;

    if (!fromEmail) {
      logger.error('❌ No FROM email configured. Cannot send admin contact notification.');
      return;
    }

    return await dispatchEmail({
      from: `Contact Form <${fromEmail}>`,
      fromEmail,
      to: adminEmail,
      subject: `📩 New Contact Inquiry: ${contactData.subject || 'Support'}`,
      html
    });
  } catch (err) {
    logger.error(`🔥 Contact Email Error: ${err.message}`);
  }
};

const sendAdminOrderCancellationEmail = async (order) => {
  try {
    const adminEmail = await getAdminRecipient();
    if (!adminEmail) return;
    
    const settings = await Settings.findOne().lean();
    const storeName = settings?.store?.name || 'Magizhchi Garments';
    
    const fromEmail = settings?.notifications?.email?.user || process.env.EMAIL_FROM;

    if (!fromEmail) {
      logger.error('❌ No FROM email configured. Cannot send admin order cancellation alert.');
      return;
    }

    return await dispatchEmail({
      from: `Cancellation Alert <${fromEmail}>`,
      fromEmail,
      to: adminEmail,
      subject: `❌ Order Cancelled #${order.orderNumber}`,
      html: `<p>Order <b>#${order.orderNumber}</b> has been cancelled by the customer.</p>`
    });
  } catch (err) {
    logger.error(`🔥 Admin Cancellation Email Error: ${err.message}`);
  }
};

const getEmailSettings = async () => {
  const settings = await Settings.findOne().lean();
  const fromEmail = settings?.notifications?.email?.user || process.env.EMAIL_FROM;
  const storeName = settings?.store?.name || 'Magizhchi Garments';
  return {
    from: fromEmail ? `${storeName} <${fromEmail}>` : null,
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



