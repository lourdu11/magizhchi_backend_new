const mongoose = require('mongoose');
require('dotenv').config();

async function checkInventory() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    const Inventory = require('./src/models/Inventory');
    const items = await Inventory.find({ isDeleted: { $ne: true } });
    console.log('--- INVENTORY ITEMS ---');
    console.log(JSON.stringify(items.map(i => ({ 
      id: i._id,
      name: i.productName, 
      color: i.color,
      size: i.size,
      totalStock: i.totalStock, 
      sku: i.sku,
      isDeleted: i.isDeleted
    })), null, 2));
    console.log('Total Count:', items.length);
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

checkInventory();
