const mongoose = require('mongoose');
const dotenv = require('dotenv');
dotenv.config({ path: './.env' });
const Banner = require('./src/models/Banner');

async function check() {
  await mongoose.connect(process.env.MONGODB_URI);
  const banners = await Banner.find().lean();
  console.log(`Found ${banners.length} banners.`);
  banners.forEach((b, i) => {
    console.log(`[${i}] ID: ${b._id} | Title: ${b.title} | DesktopImg: ${b.desktopImage} | Active: ${b.isActive} | Type: ${b.type}`);
  });
  process.exit(0);
}
check();
