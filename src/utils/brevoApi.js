const sendBrevoApi = async (mailOptions) => {
  throw new Error('Brevo API disabled. All emails route through Brevo SMTP via config/email.js');
};

module.exports = { sendBrevoApi };
