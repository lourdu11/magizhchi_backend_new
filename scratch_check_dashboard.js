require('dotenv').config();
const mongoose = require('mongoose');

async function checkDatabase() {
  try {
    console.log('Connecting to database...');
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('CONNECTED successfully!\n');

    const collections = await mongoose.connection.db.listCollections().toArray();
    console.log('COLLECTIONS IN DB:');
    collections.forEach(c => console.log(`- ${c.name}`));
    console.log('\n--- Collection Record Counts ---');

    // Get counts
    const counts = {};
    for (const col of collections) {
      const count = await mongoose.connection.db.collection(col.name).countDocuments();
      counts[col.name] = count;
      console.log(`${col.name.padEnd(20)} : ${count} records`);
    }

    console.log('\n--- Recent Orders Check ---');
    const Order = mongoose.connection.db.collection('orders');
    const recentOrders = await Order.find().sort({ createdAt: -1 }).limit(3).toArray();
    if (recentOrders.length === 0) {
      console.log('No orders found.');
    } else {
      recentOrders.forEach(o => {
        console.log(`Order #${o.orderNumber} | Total: ₹${o.pricing?.totalAmount || 0} | Status: ${o.orderStatus} | Created: ${o.createdAt}`);
      });
    }

    console.log('\n--- Recent Bills Check ---');
    const Bill = mongoose.connection.db.collection('bills');
    const recentBills = await Bill.find().sort({ createdAt: -1 }).limit(3).toArray();
    if (recentBills.length === 0) {
      console.log('No offline bills found.');
    } else {
      recentBills.forEach(b => {
        console.log(`Bill #${b.billNumber} | Total: ₹${b.pricing?.totalAmount || 0} | Staff: ${b.staffName} | Created: ${b.createdAt}`);
      });
    }

    console.log('\n--- Settings Checker ---');
    const Settings = mongoose.connection.db.collection('settings');
    const settingDocs = await Settings.find().toArray();
    console.log(`Found ${settingDocs.length} settings documents.`);
    if (settingDocs.length > 0) {
      console.log('Active settings store name:', settingDocs[0].store?.name || 'N/A');
    }

    await mongoose.disconnect();
    console.log('\nDisconnected successfully.');
  } catch (err) {
    console.error('ERROR during check:', err);
  }
}

checkDatabase();
