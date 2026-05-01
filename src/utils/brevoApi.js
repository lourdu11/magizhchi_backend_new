const https = require('https');
const logger = require('./logger');

/**
 * Sends an email using the Brevo (Sendinblue) HTTP API.
 * This is the most reliable way on Render.
 */
const sendBrevoApi = async (options) => {
  return new Promise((resolve, reject) => {
    const apiKey = (process.env.BREVO_API_KEY || process.env.EMAIL_PASSWORD || '').trim();
    if (!apiKey) {
      return reject(new Error('Brevo API Key (BREVO_API_KEY or EMAIL_PASSWORD) is missing'));
    }

    // Log masked key for verification
    const maskedKey = apiKey.length > 10 
      ? `${apiKey.substring(0, 4)}...${apiKey.substring(apiKey.length - 4)}`
      : 'INVALID_SHORT_KEY';
    logger.info(`📧 Brevo API: Using Key [${maskedKey}]`);

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
        'x-sib-api-key': apiKey,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(data)
      }
    };

    const req = https.request(reqOptions, (res) => {
      let responseData = '';
      res.on('data', (chunk) => { responseData += chunk; });
      res.on('end', () => {
        try {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            logger.info(`✅ Brevo API Success: ${toList.map(t => t.email).join(', ')}`);
            resolve(responseData ? JSON.parse(responseData) : { success: true });
          } else {
            logger.error(`❌ Brevo API Error (${res.statusCode}): ${responseData}`);
            reject(new Error(`Brevo API Error (${res.statusCode}): ${responseData}`));
          }
        } catch (parseErr) {
          logger.error(`❌ Brevo API Parse Error: ${parseErr.message} | Raw: ${responseData}`);
          reject(new Error('Failed to parse Brevo API response'));
        }
      });
    });

    req.on('error', (err) => {
      logger.error(`❌ Brevo API Request Failed: ${err.message}`);
      reject(err);
    });

    req.on('timeout', () => {
      logger.error('❌ Brevo API Request Timed Out (10s)');
      req.destroy();
      reject(new Error('Brevo API request timed out'));
    });

    req.setTimeout(10000); // 10 seconds timeout

    req.write(data);
    req.end();
  });
};

module.exports = { sendBrevoApi };
