const SibApiV3Sdk = require('sib-api-v3-sdk');
const logger = require('./logger');

/**
 * Sends an email using the official Brevo SDK.
 * This matches the user's provided reference and ensures reliable delivery.
 */
const sendBrevoApi = async (options) => {
  return new Promise((resolve, reject) => {
    try {
      const defaultClient = SibApiV3Sdk.ApiClient.instance;
      const apiKey = defaultClient.authentications['api-key'];
      
      const key = (process.env.BREVO_API_KEY || process.env.EMAIL_PASSWORD || '').trim();
      if (!key) {
        return reject(new Error('Brevo API Key (BREVO_API_KEY or EMAIL_PASSWORD) is missing'));
      }
      
      apiKey.apiKey = key;

      // Log masked key for verification
      const maskedKey = key.length > 10 
        ? `${key.substring(0, 4)}...${key.substring(key.length - 4)}`
        : 'INVALID_SHORT_KEY';
      logger.info(`📧 Brevo SDK: Using Key [${maskedKey}]`);

      const apiInstance = new SibApiV3Sdk.TransactionalEmailsApi();
      const sendSmtpEmail = new SibApiV3Sdk.SendSmtpEmail();

      const fromEmail = options.fromEmail || process.env.EMAIL_FROM || process.env.EMAIL_USER;
      const fromName = options.fromName || process.env.STORE_NAME || 'Magizhchi Garments';

      // Handle multiple recipients
      const toList = String(options.to)
        .split(',')
        .map(e => ({ email: e.trim() }))
        .filter(e => e.email && e.email.includes('@'));

      if (toList.length === 0) {
        return reject(new Error(`No valid recipients found in: ${options.to}`));
      }

      sendSmtpEmail.sender = { name: fromName, email: fromEmail };
      sendSmtpEmail.to = toList;
      sendSmtpEmail.subject = options.subject;
      sendSmtpEmail.htmlContent = options.html;
      sendSmtpEmail.textContent = options.text || '';

      logger.info(`📧 Brevo SDK: Sending [${options.subject}] to ${toList.length} recipient(s)...`);

      apiInstance.sendTransacEmail(sendSmtpEmail).then(
        (data) => {
          logger.info(`✅ Brevo SDK Success: ${toList.map(t => t.email).join(', ')}`);
          resolve(data);
        },
        (error) => {
          // Log the full error for deep analysis
          logger.error('❌ Brevo SDK Detailed Error:', JSON.stringify(error, null, 2));
          const errorMsg = error.response?.text || error.body?.message || error.message;
          reject(new Error(`Brevo SDK Error: ${errorMsg}`));
        }
      );
    } catch (err) {
      logger.error(`🔥 Brevo SDK Fatal Error: ${err.message}`);
      reject(err);
    }
  });
};

module.exports = { sendBrevoApi };
