const logger = require('./logger');

/**
 * Sends a transactional email via Brevo API using strict single-recipient structure.
 * @param {Object} mailOptions - Email options { to, subject, html, text }
 */
const sendBrevoApi = async (mailOptions) => {
  const Settings = require('../models/Settings');
  const settings = await Settings.findOne().lean();

  // ✅ ONLY recipient = mailOptions.to — nothing else
  const recipientEmail = mailOptions.to;
  
  if (!recipientEmail || typeof recipientEmail !== 'string' || recipientEmail.includes(',')) {
    throw new Error(`BLOCKED: Invalid or multiple recipients → "${recipientEmail}"`);
  }

  // ✅ Sender MUST be the Brevo verified sender email only
  const senderEmail = settings?.notifications?.email?.user 
    || process.env.EMAIL_USER 
    || process.env.EMAIL_FROM;
    
  const senderName = settings?.store?.name || process.env.STORE_NAME || 'Magizhchi Garments';

  const payload = {
    sender: { 
      name: senderName, 
      email: senderEmail  // This is FROM — NOT a recipient
    },
    to: [
      { email: recipientEmail }  // ✅ ONLY ONE recipient. Period.
    ],
    subject: mailOptions.subject,
    htmlContent: mailOptions.html,
    textContent: mailOptions.text || ''
    // ❌ NO cc, NO bcc, NO replyTo with email list, NO tags, NO listIds
  };

  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) throw new Error('BREVO_API_KEY not set');

  try {
    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': apiKey,
        'Accept': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(`Brevo API Error: ${JSON.stringify(result)}`);
    }

    logger.info(`✅ Brevo API Success: Sent to ${recipientEmail}`);
    return result;
  } catch (err) {
    logger.error(`❌ Brevo API Failure: ${err.message}`);
    throw err;
  }
};

module.exports = { sendBrevoApi };
