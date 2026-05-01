const { getTransporter } = require('../config/email');
const logger = require('../utils/logger');
const Settings = require('../models/Settings');

// Helper to get from address and store name
const getEmailSettings = async () => {
  const settings = await Settings.findOne().lean();
  const storeName = settings?.store?.name || process.env.STORE_NAME || 'Magizhchi Garments';
  const fromEmail = settings?.store?.email || process.env.EMAIL_USER || 'noreply@magizhchi.com';
  
  const from = `${storeName} <${fromEmail}>`;
  logger.info(`📧 Email Source Resolved: ${from}`);
  
  return { storeName, from };
};

// ─── OTP Email ────────────────────────────────────────────────
const sendOTPEmail = async (email, otp, purpose = 'register') => {
  const { storeName, from } = await getEmailSettings();
  const transporter = await getTransporter();
  
  const purposes = {
    register: { subject: 'Verify Your Account', title: 'Welcome! Verify your email', action: 'Complete Registration' },
    login: { subject: 'Login OTP', title: 'Your login OTP', action: 'Login to Account' },
    password_reset: { subject: 'Password Reset OTP', title: 'Reset your password', action: 'Reset Password' },
    verify_email: { subject: 'Verify Your Email', title: 'Email Verification', action: 'Verify Email' },
    verify_phone: { subject: 'Verify Your Phone', title: 'Phone Verification', action: 'Verify Phone' },
  };

  const meta = purposes[purpose] || purposes.register;
  const expireMin = parseInt(process.env.OTP_EXPIRE_MINUTES || '10');

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${meta.subject}</title>
</head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:30px 0;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.08);">

        <!-- Header -->
        <tr>
          <td style="background:#1A1A1A;padding:32px 40px;text-align:center;">
            <div style="font-family:Georgia,serif;font-size:26px;font-weight:bold;color:#D4AF37;letter-spacing:6px;">MAGIZHCHI</div>
            <div style="font-size:9px;color:rgba(255,255,255,0.4);letter-spacing:6px;margin-top:4px;">GARMENTS</div>
            <div style="width:50px;height:2px;background:linear-gradient(90deg,#D4AF37,#F5D485);margin:12px auto 0;"></div>
          </td>
        </tr>

        <!-- Body -->
        <tr>
          <td style="padding:40px 40px 24px;">
            <h2 style="margin:0 0 8px;color:#1A1A1A;font-size:22px;font-weight:700;">${meta.title}</h2>
            <p style="margin:0 0 28px;color:#666;font-size:14px;line-height:1.6;">
              Use the OTP below to ${meta.action.toLowerCase()}. This code expires in <strong>${expireMin} minutes</strong>.
            </p>

            <!-- OTP Box -->
            <div style="background:#f8f4e8;border:2px solid #D4AF37;border-radius:10px;padding:24px;text-align:center;margin-bottom:28px;">
              <p style="margin:0 0 6px;font-size:11px;color:#999;text-transform:uppercase;letter-spacing:2px;">Your OTP</p>
              <div style="font-size:42px;font-weight:800;color:#1A1A1A;letter-spacing:12px;font-family:'Courier New',monospace;">${otp}</div>
              <p style="margin:8px 0 0;font-size:11px;color:#B8960C;">Valid for ${expireMin} minutes only</p>
            </div>

            <div style="background:#FFF8E7;border-left:3px solid #D4AF37;padding:12px 16px;border-radius:0 6px 6px 0;margin-bottom:24px;">
              <p style="margin:0;font-size:12px;color:#8B6914;">
                <strong>Security Note:</strong> Never share this OTP with anyone. ${storeName} will never ask for your OTP.
              </p>
            </div>

            <p style="margin:0;color:#999;font-size:13px;">
              If you didn't request this, please ignore this email or contact us at <a href="mailto:${from}" style="color:#D4AF37;">${from}</a>
            </p>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="background:#f9f9f9;border-top:1px solid #eee;padding:20px 40px;text-align:center;">
            <p style="margin:0;color:#bbb;font-size:11px;">&copy; ${new Date().getFullYear()} ${storeName}. All rights reserved.</p>
            <p style="margin:4px 0 0;color:#ccc;font-size:10px;">Tamil Nadu, India | GST Registered</p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const isResend = process.env.EMAIL_HOST === 'smtp.resend.com';
  const mailOptions = {
    from,
    to: email,
    subject: `${meta.subject} — ${storeName}`,
    html,
    text: `Your OTP for ${meta.action} is: ${otp}\n\nValid for ${expireMin} minutes.\nDo not share this with anyone.`,
  };

  try {
    if (isResend) {
      logger.info('📧 Using Resend HTTP API for delivery...');
      const { sendResendApi } = require('../utils/resendApi');
      await sendResendApi(mailOptions);
    } else {
      await transporter.sendMail(mailOptions);
    }
    logger.info(`✅ Email delivered to: ${email}`);
  } catch (err) {
    logger.error(`❌ Email Failed: ${err.message}`);
    // If it was not resend but failed, and we have resend key, try as final fallback
    if (!isResend && process.env.EMAIL_PASSWORD?.startsWith('re_')) {
      try {
        logger.info('🔄 Retrying with Resend API fallback...');
        const { sendResendApi } = require('../utils/resendApi');
        await sendResendApi(mailOptions);
        logger.info(`✅ Email delivered via fallback to: ${email}`);
      } catch (retryErr) {
        logger.error('❌ Final email fallback failed');
      }
    }
  }
};

// ─── Order Confirmation Email ─────────────────────────────────
const sendOrderConfirmationEmail = async (email, order) => {
  const { storeName, from } = await getEmailSettings();
  const transporter = await getTransporter();
  
  const itemsHtml = order.items.map(item => `
    <tr>
      <td style="padding:10px;border-bottom:1px solid #f0f0f0;font-size:13px;color:#333;">${item.productName} (${item.variant?.size} / ${item.variant?.color})</td>
      <td style="padding:10px;border-bottom:1px solid #f0f0f0;font-size:13px;text-align:center;">${item.quantity}</td>
      <td style="padding:10px;border-bottom:1px solid #f0f0f0;font-size:13px;text-align:right;">Rs. ${(item.total || 0).toLocaleString('en-IN')}</td>
    </tr>
  `).join('');

  const html = `
<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:30px 0;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;">
        <tr><td style="background:#1A1A1A;padding:28px 40px;text-align:center;">
          <div style="font-family:Georgia,serif;font-size:22px;font-weight:bold;color:#D4AF37;letter-spacing:5px;">MAGIZHCHI</div>
          <div style="font-size:9px;color:rgba(255,255,255,0.4);letter-spacing:5px;">GARMENTS</div>
        </td></tr>
        <tr><td style="padding:32px 40px;">
          <div style="background:#f0faf0;border:1px solid #c3e6cb;border-radius:8px;padding:16px;text-align:center;margin-bottom:24px;">
            <div style="font-size:28px;margin-bottom:6px;">&#x2705;</div>
            <h2 style="margin:0;color:#1A1A1A;font-size:18px;">Order Confirmed!</h2>
            <p style="margin:4px 0 0;color:#666;font-size:13px;">Order #${order.orderNumber}</p>
          </div>
          <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;">
            <tr style="background:#f9f9f9;">
              <th style="padding:10px;text-align:left;font-size:11px;text-transform:uppercase;color:#999;">Item</th>
              <th style="padding:10px;text-align:center;font-size:11px;text-transform:uppercase;color:#999;">Qty</th>
              <th style="padding:10px;text-align:right;font-size:11px;text-transform:uppercase;color:#999;">Amount</th>
            </tr>
            ${itemsHtml}
          </table>
          <div style="text-align:right;border-top:2px solid #1A1A1A;padding-top:12px;">
            <strong style="font-size:16px;color:#D4AF37;">Total: Rs. ${(order.pricing?.totalAmount || 0).toLocaleString('en-IN')}</strong>
          </div>
          <p style="margin-top:20px;color:#666;font-size:13px;">
            Your order will be delivered within 5-7 business days. You'll receive a shipping update once dispatched.
          </p>
        </td></tr>
        <tr><td style="background:#f9f9f9;border-top:1px solid #eee;padding:16px 40px;text-align:center;">
          <p style="margin:0;color:#bbb;font-size:11px;">&copy; ${new Date().getFullYear()} ${storeName}. GST Registered.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const isResend = process.env.EMAIL_HOST === 'smtp.resend.com';
  const mailOptions = {
    from,
    to: email,
    subject: `Order Confirmed #${order.orderNumber} — ${storeName}`,
    html,
  };

  try {
    if (isResend) {
      const { sendResendApi } = require('../utils/resendApi');
      await sendResendApi(mailOptions);
    } else {
      await transporter.sendMail(mailOptions);
    }
    logger.info(`Order confirmation sent to: ${email} [order: ${order.orderNumber}]`);
  } catch (err) {
    logger.error(`❌ Email Failed: ${err.message}`);
  }
};

// ─── Low Stock Alert Email ─────────────────────────────────────
const sendLowStockEmail = async (email, item, currentStock) => {
  const { storeName, from } = await getEmailSettings();
  const transporter = await getTransporter();

  const html = `
<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:30px 0;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;">
        <tr><td style="background:#1A1A1A;padding:28px 40px;text-align:center;">
          <div style="font-family:Georgia,serif;font-size:22px;font-weight:bold;color:#D4AF37;letter-spacing:5px;">MAGIZHCHI</div>
          <div style="font-size:9px;color:rgba(255,255,255,0.4);letter-spacing:5px;">GARMENTS</div>
        </td></tr>
        <tr><td style="padding:40px;">
          <div style="background:#fff5f5;border:1px solid #feb2b2;border-radius:8px;padding:16px;text-align:center;margin-bottom:24px;">
            <div style="font-size:28px;margin-bottom:6px;">🚨</div>
            <h2 style="margin:0;color:#c53030;font-size:18px;">Low Stock Alert</h2>
          </div>
          <p style="color:#1A1A1A;font-size:15px;line-height:1.6;">
            The following product has reached its low stock threshold:
          </p>
          <div style="background:#f9f9f9;border-radius:8px;padding:20px;margin:20px 0;">
            <p style="margin:0 0 10px;"><strong>Product:</strong> ${item.productName}</p>
            <p style="margin:0 0 10px;"><strong>Variant:</strong> ${item.color} / ${item.size}</p>
            <p style="margin:0 0 10px;"><strong>Current Stock:</strong> <span style="color:#c53030;font-weight:bold;">${currentStock} Units</span></p>
            <p style="margin:0;"><strong>Threshold:</strong> ${item.lowStockThreshold || 5}</p>
          </div>
          <p style="color:#666;font-size:13px;">
            Please restock this item soon to avoid missing out on sales.
          </p>
        </td></tr>
        <tr><td style="background:#f9f9f9;border-top:1px solid #eee;padding:16px 40px;text-align:center;">
          <p style="margin:0;color:#bbb;font-size:11px;">&copy; ${new Date().getFullYear()} ${storeName}.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const isResend = process.env.EMAIL_HOST === 'smtp.resend.com';
  const mailOptions = {
    from,
    to: email,
    subject: `🚨 Low Stock Alert: ${item.productName} — ${storeName}`,
    html,
  };

  try {
    if (isResend) {
      const { sendResendApi } = require('../utils/resendApi');
      await sendResendApi(mailOptions);
    } else {
      await transporter.sendMail(mailOptions);
    }
    logger.info(`Low stock alert email sent to: ${email} [product: ${item.productName}]`);
  } catch (err) {
    logger.error(`❌ Email Failed: ${err.message}`);
  }
};

/**
 * Admin Notification: New Order
 */
const sendAdminOrderNotificationEmail = async (order) => {
  const settings = await Settings.findOne().lean();
  const alertEmail = settings?.notifications?.email?.alertEmail;
  const storeEmail = settings?.store?.email || process.env.EMAIL_USER;
  
  // Combine unique emails into a list
  const recipients = [...new Set([alertEmail, storeEmail].filter(Boolean))].join(', ');
  
  if (!recipients) {
    logger.warn('Admin Order Notification: No recipient emails found.');
    return;
  }

  const { storeName, from } = await getEmailSettings();
  const transporter = await getTransporter();

  const itemsSummary = order.items.map(item => `- ${item.productName} (${item.variant?.size}/${item.variant?.color}) x${item.quantity}`).join('\n');

  const html = `
<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:30px 0;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.08);">
        <tr><td style="background:#1A1A1A;padding:28px 40px;text-align:center;">
          <div style="font-family:Georgia,serif;font-size:22px;font-weight:bold;color:#D4AF37;letter-spacing:5px;">MAGIZHCHI</div>
          <div style="font-size:9px;color:rgba(255,255,255,0.4);letter-spacing:5px;">GARMENTS</div>
        </td></tr>
        <tr><td style="padding:40px;">
          <h2 style="margin:0 0 20px;color:#1A1A1A;font-size:20px;">🛍️ New Order Received!</h2>
          <div style="background:#f9f9f9;border-radius:8px;padding:20px;margin-bottom:24px;">
            <p style="margin:0 0 10px;"><strong>Order Number:</strong> #${order.orderNumber}</p>
            <p style="margin:0 0 10px;"><strong>Customer:</strong> ${order.shippingAddress?.name || 'Guest'}</p>
            <p style="margin:0 0 10px;"><strong>Phone:</strong> ${order.shippingAddress?.phone || 'N/A'}</p>
            <p style="margin:0 0 10px;"><strong>Total Amount:</strong> <span style="color:#D4AF37;font-weight:bold;">Rs. ${order.pricing?.totalAmount?.toLocaleString('en-IN')}</span></p>
            <p style="margin:0;"><strong>Payment Method:</strong> ${order.paymentMethod?.toUpperCase()}</p>
          </div>
          <p style="margin:0 0 10px;font-weight:bold;">Items Summary:</p>
          <pre style="background:#f5f5f5;padding:15px;border-radius:6px;font-family:monospace;white-space:pre-wrap;margin:0 0 24px;">${itemsSummary}</pre>
          <div style="text-align:center;">
            <a href="${process.env.FRONTEND_URL}/admin/orders/${order._id}" 
               style="background:#1A1A1A;color:#D4AF37;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:bold;display:inline-block;">
               View Order in Dashboard
            </a>
          </div>
        </td></tr>
        <tr><td style="background:#f9f9f9;border-top:1px solid #eee;padding:16px 40px;text-align:center;">
          <p style="margin:0;color:#bbb;font-size:11px;">Admin Notification — ${storeName}</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const isResend = process.env.EMAIL_HOST === 'smtp.resend.com';
  const mailOptions = {
    from,
    to: recipients,
    subject: `🛍️ NEW ORDER: #${order.orderNumber} — ${storeName}`,
    html,
    text: `New order received: #${order.orderNumber}\nCustomer: ${order.shippingAddress?.name}\nTotal: Rs. ${order.pricing?.totalAmount}\nItems:\n${itemsSummary}`,
  };

  try {
    if (isResend) {
      const { sendResendApi } = require('../utils/resendApi');
      await sendResendApi(mailOptions);
    } else {
      await transporter.sendMail(mailOptions);
    }
    logger.info(`Admin order notification sent to: ${recipients}`);
  } catch (err) {
    logger.error('Admin Order Notification Error:', err.message);
  }
};

/**
 * Admin Notification: New Contact Message
 */
const sendAdminContactNotificationEmail = async (contact) => {
  const settings = await Settings.findOne().lean();
  const alertEmail = settings?.notifications?.email?.alertEmail;
  const storeEmail = settings?.store?.email || process.env.EMAIL_USER;
  
  const recipients = [...new Set([alertEmail, storeEmail].filter(Boolean))].join(', ');
  if (!recipients) return;

  const { storeName, from } = await getEmailSettings();
  const transporter = await getTransporter();

  const html = `
<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:30px 0;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.08);">
        <tr><td style="background:#1A1A1A;padding:28px 40px;text-align:center;">
          <div style="font-family:Georgia,serif;font-size:22px;font-weight:bold;color:#D4AF37;letter-spacing:5px;">MAGIZHCHI</div>
          <div style="font-size:9px;color:rgba(255,255,255,0.4);letter-spacing:5px;">GARMENTS</div>
        </td></tr>
        <tr><td style="padding:40px;">
          <h2 style="margin:0 0 20px;color:#1A1A1A;font-size:20px;">📩 New Contact Inquiry</h2>
          <div style="background:#f9f9f9;border-radius:8px;padding:20px;margin-bottom:24px;">
            <p style="margin:0 0 10px;"><strong>Name:</strong> ${contact.name}</p>
            <p style="margin:0 0 10px;"><strong>Email:</strong> ${contact.email || 'N/A'}</p>
            <p style="margin:0 0 10px;"><strong>Phone:</strong> ${contact.phone || 'N/A'}</p>
            <p style="margin:0 0 10px;"><strong>Subject:</strong> ${contact.subject || 'N/A'}</p>
          </div>
          <p style="margin:0 0 10px;font-weight:bold;">Message:</p>
          <div style="background:#fef9e7;border-left:4px solid #D4AF37;padding:15px;border-radius:0 6px 6px 0;font-style:italic;color:#333;margin:0 0 24px;">
            "${contact.message}"
          </div>
          <div style="text-align:center;">
            <a href="mailto:${contact.email}" 
               style="background:#1A1A1A;color:#D4AF37;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:bold;display:inline-block;">
               Reply via Email
            </a>
          </div>
        </td></tr>
        <tr><td style="background:#f9f9f9;border-top:1px solid #eee;padding:16px 40px;text-align:center;">
          <p style="margin:0;color:#bbb;font-size:11px;">Admin Notification — ${storeName}</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const isResend = process.env.EMAIL_HOST === 'smtp.resend.com';
  const mailOptions = {
    from,
    to: recipients,
    subject: `📩 NEW CONTACT: ${contact.subject || 'Inquiry'} — ${storeName}`,
    html,
    text: `New contact inquiry from ${contact.name}\nEmail: ${contact.email}\nMessage: ${contact.message}`,
  };

  try {
    if (isResend) {
      const { sendResendApi } = require('../utils/resendApi');
      await sendResendApi(mailOptions);
    } else {
      await transporter.sendMail(mailOptions);
    }
    logger.info(`Admin contact notification sent to: ${recipients}`);
  } catch (err) {
    logger.error('Admin Contact Notification Error:', err.message);
  }
};

/**
 * Admin Notification: Order Cancellation
 */
const sendAdminOrderCancellationEmail = async (order, reason) => {
  const settings = await Settings.findOne().lean();
  const alertEmail = settings?.notifications?.email?.alertEmail;
  const storeEmail = settings?.store?.email || process.env.EMAIL_USER;
  
  const recipients = [...new Set([alertEmail, storeEmail].filter(Boolean))].join(', ');
  if (!recipients) return;

  const { storeName, from } = await getEmailSettings();
  const transporter = await getTransporter();

  const html = `
<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:30px 0;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.08);">
        <tr><td style="background:#c53030;padding:28px 40px;text-align:center;">
          <div style="font-family:Georgia,serif;font-size:22px;font-weight:bold;color:#ffffff;letter-spacing:5px;">MAGIZHCHI</div>
          <div style="font-size:9px;color:rgba(255,255,255,0.4);letter-spacing:5px;">GARMENTS</div>
        </td></tr>
        <tr><td style="padding:40px;">
          <h2 style="margin:0 0 20px;color:#c53030;font-size:20px;">🚫 Order Cancelled</h2>
          <div style="background:#f9f9f9;border-radius:8px;padding:20px;margin-bottom:24px;">
            <p style="margin:0 0 10px;"><strong>Order Number:</strong> #${order.orderNumber}</p>
            <p style="margin:0 0 10px;"><strong>Customer:</strong> ${order.shippingAddress?.name || 'Guest'}</p>
            <p style="margin:0 0 10px;"><strong>Total Amount:</strong> Rs. ${order.pricing?.totalAmount?.toLocaleString('en-IN')}</p>
            <p style="margin:0 0 10px;color:#c53030;"><strong>Reason:</strong> ${reason || 'Not provided'}</p>
          </div>
          <p style="margin:0;color:#666;font-size:13px;text-align:center;">
            The stock for this order has been automatically returned to the inventory.
          </p>
        </td></tr>
        <tr><td style="background:#f9f9f9;border-top:1px solid #eee;padding:16px 40px;text-align:center;">
          <p style="margin:0;color:#bbb;font-size:11px;">Admin Notification — ${storeName}</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const isResend = process.env.EMAIL_HOST === 'smtp.resend.com';
  const mailOptions = {
    from,
    to: recipients,
    subject: `🚫 ORDER CANCELLED: #${order.orderNumber} — ${storeName}`,
    html,
    text: `Order #${order.orderNumber} has been cancelled.\nReason: ${reason}`,
  };

  try {
    if (isResend) {
      const { sendResendApi } = require('../utils/resendApi');
      await sendResendApi(mailOptions);
    } else {
      await transporter.sendMail(mailOptions);
    }
    logger.info(`Admin cancellation notification sent to: ${recipients}`);
  } catch (err) {
    logger.error('Admin Cancellation Notification Error:', err.message);
  }
};

module.exports = { 
  sendOTPEmail, 
  sendOrderConfirmationEmail, 
  sendLowStockEmail, 
  sendAdminOrderNotificationEmail,
  sendAdminContactNotificationEmail,
  sendAdminOrderCancellationEmail
};
