const logger = require('../utils/logger');

const sendBrevoApi = async (mailOptions) => {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) {
    throw new Error('BREVO_API_KEY not set in environment');
  }

  // 🛡️ RECIPIENT SAFETY GUARD — Single recipient, no CC/BCC leakage
  delete mailOptions.cc;
  delete mailOptions.bcc;

  let recipientEmail = mailOptions.to;
  if (Array.isArray(recipientEmail)) {
    // If somehow an array was passed, take only the first element
    recipientEmail = recipientEmail[0];
  }
  if (!recipientEmail || typeof recipientEmail !== 'string') {
    throw new Error(`BLOCKED: recipient missing or invalid type → "${recipientEmail}"`);
  }

  // Discard any secondary emails in the string (comma/space/semicolon separated)
  recipientEmail = recipientEmail.trim().split(/[\s,;]/)[0].toLowerCase();

  if (!recipientEmail) {
    throw new Error('BLOCKED: recipient resolved to empty string after sanitization');
  }

  // Extract plain email from EMAIL_FROM which may be formatted as "Name <email@domain.com>"
  const rawFrom = process.env.EMAIL_FROM || process.env.EMAIL_USER || '';
  const emailMatch = rawFrom.match(/<([^>]+)>/);
  const senderEmail = emailMatch ? emailMatch[1].trim() : rawFrom.trim();
  const senderName = mailOptions.fromName || 'Magizhchi Garments';

  // Final audit log — always shows the single recipient before sending
  logger.info(`📤 [SEND AUDIT] FROM: ${senderEmail} → TO: ${recipientEmail} | SUBJECT: ${mailOptions.subject}`);

  const payload = {
    sender: {
      name: senderName,
      email: senderEmail
    },
    to: [{ email: recipientEmail }],   // ← Always exactly ONE recipient
    subject: mailOptions.subject
  };

  if (mailOptions.html) payload.htmlContent = mailOptions.html;
  if (mailOptions.text) payload.textContent = mailOptions.text;

  logger.info(`📧 Brevo API → TO: ${recipientEmail}`);

  const response = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key': apiKey
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const err = await response.json();
    const errorMsg = JSON.stringify(err);
    logger.error(`❌ Brevo API Error: ${errorMsg}`);

    // ── GMAIL SMTP FALLBACK ──
    // If Brevo is blocked (IP whitelist, invalid key, etc), try Gmail SMTP
    if (process.env.EMAIL_USER && process.env.EMAIL_PASSWORD && (process.env.NODE_ENV === 'development' || errorMsg.includes('unrecognised IP'))) {
      try {
        const nodemailer = require('nodemailer');
        const gmailPass = (process.env.EMAIL_PASSWORD || '').replace(/\s/g, '');
        
        const transporter = nodemailer.createTransport({
          host: 'smtp.gmail.com',
          port: 587,
          secure: false,
          auth: {
            user: process.env.EMAIL_USER,
            pass: gmailPass
          }
        });

        logger.info(`🔄 Brevo Blocked. Attempting Gmail SMTP Fallback (Verified Pass) → ${recipientEmail}`);
        
        await transporter.sendMail({
          from: `"Magizhchi Garments" <${process.env.EMAIL_USER}>`, // Show store name, not Gmail account name
          to: recipientEmail,
          subject: mailOptions.subject,
          text: mailOptions.text,
          html: mailOptions.html
        });

        logger.info(`✅ Gmail Fallback Success! Email delivered via SMTP.`);
        return { success: true, message: 'Delivered via Gmail SMTP fallback', messageId: 'gmail-fallback' };
      } catch (smtpErr) {
        logger.error(`❌ Gmail Fallback ALSO Failed: ${smtpErr.message}`);
      }
    }

    // ── TERMINAL FALLBACK (Last Resort) ──
    if (process.env.NODE_ENV === 'development' || errorMsg.includes('unrecognised IP')) {
      console.log('\n' + '═'.repeat(60));
      console.log('🚧  BREVO API BLOCKED — TERMINAL FALLBACK  🚧');
      console.log('═'.repeat(60));
      console.log(`TO:      ${recipientEmail}`);
      console.log(`SUBJECT: ${mailOptions.subject}`);
      console.log('═'.repeat(60) + '\n');
      
      return { success: true, message: 'Fallback: Logged to terminal', messageId: 'dev-fallback' };
    }

    throw new Error(`Brevo API Error: ${errorMsg}`);
  }

  logger.info(`✅ Brevo API: Email sent successfully to ${recipientEmail}`);
  return await response.json();
};

module.exports = { sendBrevoApi };
