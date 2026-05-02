const express = require('express');
const router = express.Router();
const SibApiV3Sdk = require('sib-api-v3-sdk');

router.post('/test-force', async (req, res) => {
  try {
    const apiKey = process.env.BREVO_API_KEY;
    const senderEmail = process.env.EMAIL_USER;

    if (!apiKey) throw new Error('BREVO_API_KEY is missing');
    if (!senderEmail) throw new Error('EMAIL_USER is missing (Sender Email)');

    const client = SibApiV3Sdk.ApiClient.instance;
    const apiKeyAuth = client.authentications['api-key'];
    apiKeyAuth.apiKey = apiKey;

    const emailApi = new SibApiV3Sdk.TransactionalEmailsApi();

    // Use a verified sender from environment
    const sendSmtpEmail = new SibApiV3Sdk.SendSmtpEmail();
    sendSmtpEmail.subject = "Test Order Alert (Force V5)";
    sendSmtpEmail.htmlContent = "<h2>Test Order Notification</h2><p>This is a test alert from Magizhchi Admin using the Brevo SDK.</p>";
    sendSmtpEmail.sender = { "name": "Magizhchi Admin", "email": "lncoderise@11134769.brevosend.com" };
    sendSmtpEmail.to = [{ "email": "lncoderise@gmail.com" }]; // Hardcoded test recipient as per user's prompt

    const result = await emailApi.sendTransacEmail(sendSmtpEmail);

    res.status(200).json({
      success: true,
      data: {
        emailOrder: {
          messageId: result.messageId
        }
      }
    });
  } catch (err) {
    console.error('❌ Brevo SDK Error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
