const logger = require('../utils/logger');

const sendBrevoApi = async (mailOptions) => {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) {
    throw new Error('BREVO_API_KEY not set in environment');
  }

  // Single recipient guard
  const recipientEmail = mailOptions.to;
  if (!recipientEmail || typeof recipientEmail !== 'string') {
    throw new Error(`BLOCKED: recipient missing → "${recipientEmail}"`);
  }
  if (recipientEmail.includes(',') || recipientEmail.includes(';')) {
    throw new Error(`BLOCKED: multiple recipients → "${recipientEmail}"`);
  }

  const senderEmail = process.env.EMAIL_FROM || process.env.EMAIL_USER;
  const senderName = mailOptions.fromName || 'Magizhchi Garments';

  const payload = {
    sender: {
      name: senderName,
      email: senderEmail
    },
    to: [{ email: recipientEmail }],
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
    throw new Error(`Brevo API Error: ${JSON.stringify(err)}`);
  }

  logger.info(`✅ Brevo API: Email sent successfully to ${recipientEmail}`);
  return await response.json();
};

module.exports = { sendBrevoApi };
