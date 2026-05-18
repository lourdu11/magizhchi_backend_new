const { MongoClient } = require('mongodb');

const LOCAL_URI = 'mongodb://127.0.0.1:27017/magizhchi';
const CLOUD_URI = 'mongodb+srv://SproutsOrgs:SproutsOrgs12345@cluster0.1i9dtge.mongodb.net/magizhchi?retryWrites=true&w=majority';

async function runMigration() {
  console.log('🚀 Starting Database Migration: Local to MongoDB Atlas Cloud...\n');
  
  const localClient = new MongoClient(LOCAL_URI);
  const cloudClient = new MongoClient(CLOUD_URI);

  try {
    console.log('🔌 Connecting to Local MongoDB (127.0.0.1:27017)...');
    await localClient.connect();
    console.log('✅ Connected to Local MongoDB.');

    console.log('🔌 Connecting to MongoDB Atlas Cloud...');
    await cloudClient.connect();
    console.log('✅ Connected to MongoDB Atlas Cloud.\n');

    const localDb = localClient.db();
    const cloudDb = cloudClient.db();

    console.log('🔍 Listing local collections...');
    const collections = await localDb.listCollections().toArray();
    const collectionNames = collections.map(c => c.name);
    console.log(`📋 Found ${collectionNames.length} collections: ${collectionNames.join(', ')}\n`);

    for (const name of collectionNames) {
      if (name.startsWith('system.')) {
        console.log(`⏭️ Skipping system collection: ${name}`);
        continue;
      }

      console.log(`--------------------------------------------------`);
      console.log(`📦 Collection: "${name}"`);
      
      const documents = await localDb.collection(name).find({}).toArray();
      console.log(`📖 Read ${documents.length} documents from Local.`);

      if (documents.length === 0) {
        console.log(`⚠️ Collection "${name}" is empty. Skipping.`);
        continue;
      }

      console.log(`🗑️ Cleaning existing database documents in Cloud collection "${name}"...`);
      await cloudDb.collection(name).deleteMany({});

      console.log(`📤 Uploading ${documents.length} documents to Cloud...`);
      const result = await cloudDb.collection(name).insertMany(documents);
      console.log(`✅ Synced! (${result.insertedCount} documents successfully copied)`);
    }

    console.log(`\n==================================================`);
    console.log('🎉 ALL COLLECTIONS SUCCESSFULLY SYNCHRONIZED TO THE CLOUD!');
    console.log(`==================================================\n`);
  } catch (error) {
    console.error('🔥 Migration crashed with error:', error);
  } finally {
    await localClient.close();
    await cloudClient.close();
    console.log('🔌 Database connections safely closed.');
  }
}

runMigration();
