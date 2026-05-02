const sendBrevoApi = async (mailOptions) => {
  throw new Error('Brevo is disabled. All emails route through Gmail SMTP only.');
};

module.exports = { sendBrevoApi };
