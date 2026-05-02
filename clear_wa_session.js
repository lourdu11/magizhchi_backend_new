require('dotenv').config();
const mongoose = require('mongoose');

mongoose.connect(process.env.MONGODB_URI).then(async () => {
  const WhatsAppSession = require('./src/models/WhatsAppSession');
  const result = await WhatsAppSession.deleteOne({ key: 'baileys-auth' });
  console.log('WhatsApp Session Deleted from DB:', result);
  process.exit(0);
}).catch(e => {
  console.error(e);
  process.exit(1);
});
