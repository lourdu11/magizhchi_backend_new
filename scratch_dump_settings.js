const mongoose = require('mongoose');
const dotenv = require('dotenv');
dotenv.config({ path: './.env' });

async function dump() {
  await mongoose.connect(process.env.MONGODB_URI);
  const Settings = mongoose.model('Settings', new mongoose.Schema({}, { strict: false }));
  const docs = await Settings.find({});
  console.log(`Found ${docs.length} settings documents.`);
  docs.forEach((d, i) => {
    console.log(`[${i}] ID: ${d._id} | AlertEmail: ${d.notifications?.email?.alertEmail} | Updated: ${d.updatedAt}`);
  });
  process.exit(0);
}
dump();
