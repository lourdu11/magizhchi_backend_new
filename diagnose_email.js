require('dotenv').config();
const mongoose = require('mongoose');

async function diagnose() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to MongoDB\n');

  const Settings = require('./src/models/Settings');
  const all = await Settings.find().lean();
  
  console.log(`Settings documents found: ${all.length}`);
  
  all.forEach((s, i) => {
    const notif = s.notifications || {};
    const email = notif.email || {};
    const orderNotif = notif.orderNotifications || {};
    const contactNotif = notif.contactNotifications || {};
    const stockNotif = notif.lowStockAlert || {};
    
    console.log(`\n--- Settings Doc ${i+1} ---`);
    console.log('alertEmail (raw)    :', JSON.stringify(email.alertEmail));
    console.log('orderNotif.enabled  :', orderNotif.enabled);
    console.log('orderNotif.method   :', orderNotif.method);
    console.log('contactNotif.enabled:', contactNotif.enabled);
    console.log('contactNotif.method :', contactNotif.method);
    console.log('stockAlert.enabled  :', stockNotif.enabled);
    console.log('stockAlert.method   :', stockNotif.method);
    
    // Check if alertEmail has multiple emails
    const rawEmail = (email.alertEmail || '').trim();
    const parts = rawEmail.split(/[\s,;]+/).filter(Boolean);
    if (parts.length > 1) {
      console.log('\n🚨 MULTIPLE EMAILS DETECTED IN alertEmail:', parts);
    } else {
      console.log('\n✅ Single email in alertEmail:', parts[0] || '(empty)');
    }
  });
  
  await mongoose.disconnect();
  console.log('\nDone.');
}

diagnose().catch(e => { console.error(e); process.exit(1); });
