require('dotenv').config();
const mongoose = require('mongoose');
const Inventory = require('./src/models/Inventory');

async function testSKUGeneration() {
  try {
    console.log('Connecting to database to test SKU...');
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected!');

    // Mock body for createInventoryItem
    const mockItems = [
      { productName: "Black Shirt", size: "XL", color: "Black" },
      { productName: "Black Shirt", size: "L", color: "Black" },
      { productName: "Blue Jeans", size: "32", color: "Blue" }
    ];

    console.log('\n--- Simulation of SKU Auto-Generator ---');
    
    // Simulate our generator logic
    const totalCount = await Inventory.countDocuments({});
    console.log(`Current DB total inventory records count: ${totalCount}`);

    mockItems.forEach((item, index) => {
      const { productName, size, color } = item;
      const words = productName.trim().split(/\s+/).filter(Boolean);
      let initials = 'PRD';
      if (words.length === 1) {
        initials = words[0].slice(0, 3).toUpperCase();
      } else if (words.length >= 2) {
        const firstInit = words[0][0].toUpperCase();
        const secondWord = words[1].toLowerCase();
        let secondInit = words[1][0].toUpperCase();
        if (secondWord.startsWith('sh')) {
          secondInit = 'SH';
        } else if (words.length > 2) {
          secondInit += words[2][0].toUpperCase();
        }
        initials = (firstInit + secondInit).toUpperCase();
      }
      
      const skuBase = `${initials}-${size.trim()}`.toUpperCase().replace(/\s+/g, '');
      const sequenceSuffix = String(totalCount + index + 1).padStart(3, '0');
      const finalSku = `${skuBase}-${sequenceSuffix}`;

      console.log(`Product: "${productName}" (${size}) | Color: ${color} => Generated SKU: ${finalSku}`);
    });

    await mongoose.disconnect();
    console.log('\nDisconnected successfully.');
  } catch (err) {
    console.error('ERROR during testing:', err);
  }
}

testSKUGeneration();
