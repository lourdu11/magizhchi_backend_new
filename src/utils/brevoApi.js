const https = require('https');
const logger = require('./logger');

/**
 * Sends an email using the Brevo (Sendinblue) HTTP API.
 * This is the most reliable way on Render.
 */
const sendBrevoApi = async (options) => {
  return new Promise((resolve, reject) => {
    const apiKey = process.env.EMAIL_PASSWORD; // We will use this for the API Key
    if (!apiKey) {
      return reject(new Error('Brevo API Key (EMAIL_PASSWORD) is missing'));
    }

    const data = JSON.stringify({
      sender: { 
        name: 'Magizhchi Garments', 
        email: 'lncoderise@gmail.com' // This must be your verified sender email in Brevo
      },
      to: [{ email: options.to }],
      subject: options.subject,
      htmlContent: options.html
    });

    const reqOptions = {
      hostname: 'api.brevo.com',
      port: 443,
      path: '/v3/smtp/email',
      method: 'POST',
      headers: {
        'accept': 'application/json',
        'api-key': apiKey,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(data)
      }
    };

    const req = https.request(reqOptions, (res) => {
      let responseData = '';
      res.on('data', (chunk) => { responseData += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          logger.info(`✅ Email Sent via Brevo API: ${options.to}`);
          resolve(JSON.parse(responseData));
        } else {
          logger.error(`❌ Brevo API Error (${res.statusCode}): ${responseData}`);
          reject(new Error(`Brevo API Error: ${responseData}`));
        }
      });
    });

    req.on('error', (err) => {
      logger.error('❌ Brevo API Request Failed:', err.message);
      reject(err);
    });

    req.write(data);
    req.end();
  });
};

module.exports = { sendBrevoApi };
