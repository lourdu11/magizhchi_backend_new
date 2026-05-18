require('dotenv').config();
const mongoose = require('mongoose');

async function repairDB() {
  console.log('🛠️  Starting MongoDB Repair Script...');
  
  // Verify DB Name
  const uri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/magizhchi';
  if (!uri.includes('/magizhchi')) {
    console.error('❌ Connection string does not target "magizhchi" database. Aborting to prevent accidental operations on wrong DB.');
    process.exit(1);
  }
  
  console.log(`🔌 Connecting to: ${uri}`);
  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  
  // Target Collections
  const targetCollections = ['products', 'inventories', 'orders', 'bills', 'categories', 'auditlogs', 'salesanalysis'];
  const existingCollections = await db.listCollections().toArray();
  const existingNames = existingCollections.map(c => c.name);
  
  for (const collName of targetCollections) {
    if (!existingNames.includes(collName)) {
      console.log(`\n⚠️  Collection [${collName}] does not exist yet.`);
      continue;
    }
    
    const coll = db.collection(collName);
    const count = await coll.countDocuments();
    const stats = await db.command({ collStats: collName });
    
    console.log(`\n📊 Collection: [${collName}]`);
    console.log(`   - Documents: ${count}`);
    console.log(`   - Storage Size: ${(stats.storageSize / 1024).toFixed(2)} KB`);
    console.log(`   - Indexes: ${stats.nindexes} (Size: ${(stats.totalIndexSize / 1024).toFixed(2)} KB)`);
    
    if (count === 0) {
      console.log(`   🚨 Detected 0 documents in [${collName}]. Checking for orphaned indexes...`);
      const indexes = await coll.indexes();
      // Keep _id_ index, drop the rest
      const indexesToDrop = indexes.filter(idx => idx.name !== '_id_');
      
      if (indexesToDrop.length > 0) {
        console.log(`   🧹 Dropping ${indexesToDrop.length} orphaned index(es)...`);
        for (const idx of indexesToDrop) {
          try {
            await coll.dropIndex(idx.name);
            console.log(`      ✅ Dropped: ${idx.name}`);
          } catch (err) {
            console.error(`      ❌ Failed to drop ${idx.name}: ${err.message}`);
          }
        }
      } else {
        console.log(`   ✅ No orphaned custom indexes found.`);
      }
      
      // Compact collection (Note: Requires wiredTiger storage engine, which is default)
      try {
        console.log(`   🗜️  Running compact command on [${collName}]...`);
        await db.command({ compact: collName });
        console.log(`   ✅ Compaction successful.`);
      } catch (err) {
        console.error(`   ⚠️  Compaction skipped or failed: ${err.message} (Often requires admin privileges or specific storage engines)`);
      }
    } else {
      console.log(`   ✅ Collection is populated. No index cleanup needed.`);
    }
  }
  
  console.log('\n🎉 DB Repair Script Completed!');
  await mongoose.disconnect();
  process.exit(0);
}

repairDB().catch(err => {
  console.error('\n❌ Fatal Error during repair:', err);
  process.exit(1);
});
