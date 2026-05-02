require('dotenv').config();
const mongoose = require('mongoose');

mongoose.connect(process.env.MONGODB_URI).then(async () => {
  const Settings = require('./src/models/Settings');
  const settings = await Settings.findOne().lean();
  
  console.log('Current alertEmail in DB:', settings?.notifications?.email?.alertEmail);
  console.log('EMAIL_USER env:', process.env.EMAIL_USER);
  console.log('EMAIL_FROM env:', process.env.EMAIL_FROM);
  console.log('BREVO_API_KEY set?', !!process.env.BREVO_API_KEY);

  // Now test send directly
  const { sendBrevoApi } = require('./src/utils/brevoApi');
  
  try {
    const result = await sendBrevoApi({
      to: settings?.notifications?.email?.alertEmail,
      subject: 'DIRECT TEST - ' + new Date().toISOString(),
      html: '<h1>Direct test from backend script</h1><p>If you see this, Brevo is working!</p>'
    });
    console.log('Brevo ACCEPTED:', JSON.stringify(result));
  } catch(e) {
    console.error('Brevo REJECTED:', e.message);
  }
  
  process.exit(0);
}).catch(e => { console.error(e); process.exit(1); });
