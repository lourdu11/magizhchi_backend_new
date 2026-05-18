const mongoose = require('mongoose');

async function checkDB() {
  const uri = 'mongodb://127.0.0.1:27017/magizhchi';
  console.log(`Connecting to ${uri}...`);
  await mongoose.connect(uri);
  console.log('Connected!');

  const db = mongoose.connection.db;
  const collections = await db.listCollections().toArray();
  console.log('\n--- Collections and Document Counts ---');
  for (const col of collections) {
    const count = await db.collection(col.name).countDocuments();
    console.log(`Collection: ${col.name} -> ${count} documents`);
  }

  // Check all users
  const allUsers = await db.collection('users').find({}).toArray();
  console.log(`\nSpecific collection 'users' count: ${allUsers.length}`);
  allUsers.forEach(u => {
    console.log(`User: ${u.name} / ${u.email} / ${u.role} / ${u.phone}`);
  });

  // Check products count
  const productsCount = await db.collection('products').countDocuments();
  console.log(`Specific collection 'products' count: ${productsCount}`);

  await mongoose.disconnect();
  console.log('\nDisconnected.');
}

checkDB().catch(console.error);
