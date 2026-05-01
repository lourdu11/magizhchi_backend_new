const https = require('https');
const logger = require('./logger');

/**
 * Sends an email using the Brevo (Sendinblue) HTTP API.
 * This is the most reliable way on Render.
 */
const sendBrevoApi = async (options) => {
  return new Promise((resolve, reject) => {
    const apiKey = (process.env.EMAIL_PASSWORD || '').trim();
    if (!apiKey) {
      return reject(new Error('Brevo API Key (EMAIL_PASSWORD) is missing'));
    }

    const fromEmail = options.fromEmail || process.env.EMAIL_FROM || process.env.EMAIL_USER;
    const fromName = options.fromName || process.env.STORE_NAME || 'Magizhchi Garments';

    // Handle multiple recipients (split by comma if string)
    const toList = String(options.to)
      .split(',')
      .map(e => ({ email: e.trim() }))
      .filter(e => e.email && e.email.includes('@'));

    if (toList.length === 0) {
      return reject(new Error(`No valid recipients found in: ${options.to}`));
    }

    logger.info(`📧 Brevo API: Sending [${options.subject}] to ${toList.length} recipient(s)...`);

    const data = JSON.stringify({
      sender: { name: fromName, email: fromEmail },
      to: toList,
      subject: options.subject,
      htmlContent: options.html,
      textContent: options.text || ''
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
          logger.info(`✅ Brevo API Success: ${toList.map(t => t.email).join(', ')}`);
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
