const https = require('https');
const logger = require('./logger');

/**
 * Sends an email using the Resend HTTP API.
 * This bypasses SMTP port blocking on hosting providers like Render.
 */
const sendResendApi = async (options) => {
  return new Promise((resolve, reject) => {
    const apiKey = process.env.EMAIL_PASSWORD;
    if (!apiKey) {
      return reject(new Error('Resend API Key (EMAIL_PASSWORD) is missing'));
    }

    // For Resend Free tier, we MUST use onboarding@resend.dev unless domain is verified
    const payload = {
      from: 'onboarding@resend.dev', 
      to: Array.isArray(options.to) ? options.to : [options.to],
      subject: options.subject || 'Notification',
      html: options.html || '',
      text: options.text || ''
    };

    const data = JSON.stringify(payload);

    const reqOptions = {
      hostname: 'api.resend.com',
      port: 443,
      path: '/emails',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(data)
      }
    };

    const req = https.request(reqOptions, (res) => {
      let responseData = '';
      res.on('data', (chunk) => { responseData += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          logger.info(`✅ Email Sent via Resend API: ${options.to}`);
          resolve(JSON.parse(responseData));
        } else {
          logger.error(`❌ Resend API Error (${res.statusCode}): ${responseData}`);
          reject(new Error(`Resend API Error: ${responseData}`));
        }
      });
    });

    req.on('error', (err) => {
      logger.error('❌ Resend API Request Failed:', err.message);
      reject(err);
    });

    req.write(data);
    req.end();
  });
};

module.exports = { sendResendApi };
