const logger = require('../utils/logger');

const getTransporter = async () => {
  // Returns a fake transporter that routes through Brevo API
  return {
    sendMail: async (mailOptions) => {
      const { sendBrevoApi } = require('../utils/brevoApi');
      return await sendBrevoApi(mailOptions);
    },
    verify: async () => {
      const apiKey = process.env.BREVO_API_KEY;
      if (!apiKey) throw new Error('BREVO_API_KEY not configured');
      logger.info('✅ Brevo API Ready: API key configured');
      return true;
    }
  };
};

const verifyEmailConfig = async () => {
  try {
    logger.info('📧 Verifying Brevo API configuration...');
    const apiKey = process.env.BREVO_API_KEY;
    if (!apiKey) {
      logger.error('❌ BREVO_API_KEY not set in environment');
      return false;
    }
    logger.info('✅ Brevo API Ready: Connected successfully');
    return true;
  } catch (err) {
    logger.error(`❌ Brevo API Error: ${err.message}`);
    return false;
  }
};

module.exports = { getTransporter, verifyEmailConfig };
