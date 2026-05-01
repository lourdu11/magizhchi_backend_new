const { MongoClient } = require('mongodb');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '../.env') });

const LOCAL_URI = 'mongodb://localhost:27017';
const CLOUD_URI = process.env.MONGODB_URI;

async function migrate() {
  console.log('🚀 Starting Data Migration to Atlas...');
  
  const localClient = new MongoClient(LOCAL_URI);
  const cloudClient = new MongoClient(CLOUD_URI);

  try {
    await localClient.connect();
    await cloudClient.connect();
    console.log('✅ Connected to both databases');

    const localDb = localClient.db('magizhchi');
    const cloudDb = cloudClient.db('magizhchi');

    const collections = await localDb.listCollections().toArray();
    const collectionNames = collections.map(c => c.name).filter(name => !name.startsWith('system.'));

    for (const name of collectionNames) {
      console.log(`📦 Migrating collection: ${name}...`);
      
      const documents = await localDb.collection(name).find({}).toArray();
      
      if (documents.length > 0) {
        // Clear cloud collection first
        await cloudDb.collection(name).deleteMany({});
        
        try {
          // Use ordered: false to continue inserting even if one fails
          const result = await cloudDb.collection(name).insertMany(documents, { ordered: false });
          console.log(`   ✅ Migrated ${result.insertedCount} documents`);
        } catch (insertErr) {
          if (insertErr.code === 11000) {
            console.log(`   ⚠️ Partial migration due to duplicate keys (skipped duplicates)`);
            console.log(`   ✅ Migrated ${insertErr.result.nInserted} documents`);
          } else {
            throw insertErr;
          }
        }
      } else {
        console.log(`   ℹ️ Collection is empty, skipping`);
      }
    }

    console.log('\n✨ Migration Completed Successfully!');
  } catch (err) {
    console.error('❌ Migration Failed:', err.message);
  } finally {
    await localClient.close();
    await cloudClient.close();
  }
}

migrate();
