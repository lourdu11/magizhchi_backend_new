const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');

// Load env
dotenv.config({ path: './.env' });

async function cleanup() {
  try {
    console.log('🔗 Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected.');

    const Settings = mongoose.model('Settings', new mongoose.Schema({}, { strict: false }));

    console.log('🛠️  Ensuring single Source of Truth in MongoDB...');
    
    // Set correct alertEmail and verified sender
    const update = { 
      $set: { 
        "notifications.email.alertEmail": "xavierbritto16@gmail.com", // Adjust this if deploy1email1 was intended
        "notifications.email.user": "lncoderise@gmail.com" 
      } 
    };

    const result = await Settings.updateMany({}, update);
    console.log(`✅ Updated ${result.modifiedCount} settings documents.`);

    // Final sanity check: Keep only one
    const docs = await Settings.find().sort({ updatedAt: -1 });
    if (docs.length > 1) {
      console.log('⚠️  Multiple settings detected. Keeping only the latest...');
      const keepId = docs[0]._id;
      const delResult = await Settings.deleteMany({ _id: { $ne: keepId } });
      console.log(`🗑️  Deleted ${delResult.deletedCount} stale documents.`);
    }

    console.log('✨ MongoDB Fix Complete.');
    process.exit(0);
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  }
}

cleanup();
