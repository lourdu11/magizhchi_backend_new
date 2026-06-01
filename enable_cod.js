require('dotenv').config();
const mongoose = require('mongoose');
mongoose.connect(process.env.MONGODB_URI).then(async () => {
  const db = mongoose.connection.db;
  await db.collection('settings').updateOne({ _id: new mongoose.Types.ObjectId('6a0b471d6a9faaad13dd3700') }, { $set: { 'payment.codEnabled': true } });
  await db.collection('settings').deleteOne({ key: 'public' });
  console.log('COD fixed in actual document');
  process.exit(0);
});
