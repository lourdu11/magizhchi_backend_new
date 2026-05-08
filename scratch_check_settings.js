require('dotenv').config();
const mongoose = require('mongoose');
const Settings = require('./src/models/Settings');

async function check() {
  await mongoose.connect(process.env.MONGODB_URI);
  const s = await Settings.findOne();
  console.log('=== SETTINGS DUMP ===');
  console.log(JSON.stringify(s, null, 2));
  console.log('=====================');
  process.exit(0);
}

check();
