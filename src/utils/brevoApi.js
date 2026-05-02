const axios = require('axios');
const logger = require('./logger');

/**
 * Sends a transactional email via Brevo API using Axios for maximum stability.
 * @param {Object} options - Email options { to, subject, html, fromEmail, fromName }
 */
const sendBrevoApi = async (options) => {
  const { to, subject, html, fromEmail, fromName } = options;
  
  const apiKey = (process.env.BREVO_API_KEY || process.env.EMAIL_PASSWORD || '').trim();
  
  if (!apiKey || (!apiKey.startsWith('xkeysib-') && !apiKey.startsWith('xsmtpsib-'))) {
    logger.error('❌ Brevo API: Missing or invalid API key');
    throw new Error('Email service misconfigured (Invalid Brevo Key)');
  }

  // Ensure 'to' is a single string and doesn't contain multiple emails
  if (typeof to !== 'string' || to.includes(',') || to.includes(';') || to.includes(' ')) {
    logger.error(`❌ Brevo API Blocked: Invalid or multiple recipients detected -> ${to}`);
    throw new Error('Email sending blocked: Multiple recipients are not allowed.');
  }

  const toList = [{ email: to.trim().toLowerCase() }];

  const payload = {
    sender: { 
      name: fromName || process.env.STORE_NAME || 'Magizhchi Garments', 
      email: fromEmail || process.env.EMAIL_FROM || process.env.EMAIL_USER 
    },
    to: toList,
    subject: subject,
    htmlContent: html
  };

  try {
    logger.info(`📧 Brevo API: Sending to ${toList.map(t => t.email).join(', ')}...`);
    
    const response = await axios.post('https://api.brevo.com/v3/smtp/email', payload, {
      headers: {
        'api-key': apiKey,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      timeout: 10000 // 10 second timeout
    });

    logger.info('✅ Brevo API Success:', response.data.messageId || 'Sent');
    return response.data;
  } catch (error) {
    const errorData = error.response?.data || {};
    const errorMsg = errorData.message || error.message;
    
    logger.error('❌ Brevo API Failure:', {
      status: error.response?.status,
      message: errorMsg,
      code: errorData.code,
      details: errorData
    });

    throw new Error(`Brevo API Error: ${errorMsg}`);
  }
};

module.exports = { sendBrevoApi };
