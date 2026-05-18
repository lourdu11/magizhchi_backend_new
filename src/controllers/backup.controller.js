const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const logger = require('../utils/logger');
const ApiResponse = require('../utils/apiResponse');

// Map frontend selection keys to MongoDB Collection names
const MODULE_COLLECTIONS_MAP = {
  offlineBills: ['bills', 'returns'],
  orders: ['orders'],
  createBill: ['carts'],
  analysis: ['stockmovements', 'wastages'],
  broadcast: ['broadcasts', 'broadcastlogs'],
  category: ['categories'],
  catalog: ['products', 'inventories'],
  customer: ['users'], // Filtered by role='user'
  staff: ['users'], // Filtered by role='staff'
  banners: ['banners'],
  reviews: ['reviews'],
  procurement: ['suppliers', 'purchases'],
  coupons: ['coupons'],
  support: ['chatqueries', 'contacts'],
  templates: ['messagetemplates'],
  counters: ['counters']
};

/**
 * 1. Export Collections to JSON Backup
 */
exports.exportCollectionsToBackup = async (selections, timestamp) => {
  try {
    const backupDir = path.join(__dirname, '../../backups', `reset-${timestamp}`);
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }

    const collectionsToBackup = new Set();
    for (const [key, isSelected] of Object.entries(selections)) {
      if (isSelected && MODULE_COLLECTIONS_MAP[key]) {
        MODULE_COLLECTIONS_MAP[key].forEach(c => collectionsToBackup.add(c));
      }
    }

    const db = mongoose.connection.db;
    const exportStats = {};

    for (const collName of collectionsToBackup) {
      const coll = db.collection(collName);
      let query = {};
      
      // Special handling for users collection (customers vs staff)
      if (collName === 'users') {
        if (selections.customer && !selections.staff) query = { role: 'user' };
        else if (selections.staff && !selections.customer) query = { role: 'staff' };
        else if (selections.staff && selections.customer) query = { role: { $in: ['user', 'staff'] } };
        else continue;
      }

      const docs = await coll.find(query).toArray();
      if (docs.length > 0) {
        fs.writeFileSync(path.join(backupDir, `${collName}.json`), JSON.stringify(docs, null, 2));
      }
      exportStats[collName] = docs.length;
    }

    logger.info(`💾 JSON Backup complete at: ${backupDir}`, exportStats);
    return { backupPath: backupDir, counts: exportStats };
  } catch (err) {
    logger.error('Failed to export JSON backup:', err);
    throw err;
  }
};

/**
 * 2. Soft Delete to Shadow Collections
 */
exports.softDeleteToShadow = async (selections, timestamp) => {
  const db = mongoose.connection.db;
  const collectionsToShadow = new Set();
  
  for (const [key, isSelected] of Object.entries(selections)) {
    if (isSelected && MODULE_COLLECTIONS_MAP[key]) {
      MODULE_COLLECTIONS_MAP[key].forEach(c => collectionsToShadow.add(c));
    }
  }

  const shadowStats = {};

  for (const collName of collectionsToShadow) {
    const sourceColl = db.collection(collName);
    const shadowCollName = `${collName}_deleted_${timestamp}`;
    const shadowColl = db.collection(shadowCollName);

    let query = {};
    if (collName === 'users') {
      if (selections.customer && !selections.staff) query = { role: 'user' };
      else if (selections.staff && !selections.customer) query = { role: 'staff' };
      else if (selections.staff && selections.customer) query = { role: { $in: ['user', 'staff'] } };
      else continue;
    }

    const docs = await sourceColl.find(query).toArray();
    if (docs.length > 0) {
      await shadowColl.insertMany(docs);
    }
    
    // Hard drop the collection if we are resetting the entire module to clear orphaned indexes and storage
    if (Object.keys(query).length === 0) {
      await sourceColl.drop().catch(() => {});
    } else if (docs.length > 0) {
      // If we are only resetting specific documents (like 'users' with role='staff'), use deleteMany
      await sourceColl.deleteMany(query);
    }
    
    shadowStats[collName] = docs.length;
  }

  logger.info(`🌒 Shadow Copy complete for timestamp: ${timestamp}`, shadowStats);
  return shadowStats;
};

/**
 * 3. Restore Last Reset API
 */
exports.restoreLastReset = async (req, res, next) => {
  try {
    const { logId } = req.body;
    if (!logId) return ApiResponse.error(res, 'Backup log ID required', 400);

    const AuditLog = require('../models/AuditLog');
    const log = await AuditLog.findById(logId);
    if (!log || log.action !== 'DATA_RESET') return ApiResponse.error(res, 'Reset record not found', 404);

    const timestamp = log.details?.timestamp;
    if (!timestamp) return ApiResponse.error(res, 'Backup timestamp missing in audit log', 500);

    if (new Date() > new Date(log.canRestoreUntil)) {
      return ApiResponse.error(res, 'Restore grace period (30 mins) has expired.', 403);
    }

    const db = mongoose.connection.db;
    const collectionsToRestore = Object.keys(log.documentsCounts);
    const restoredCounts = {};

    for (const collName of collectionsToRestore) {
      const shadowCollName = `${collName}_deleted_${timestamp}`;
      const shadowColl = db.collection(shadowCollName);
      const targetColl = db.collection(collName);

      const docs = await shadowColl.find({}).toArray();
      if (docs.length > 0) {
        // Strip _id to avoid duplicate key errors if some were recreated, or handle upsert
        // For direct restore, we assume target is empty, but we must use BulkWrite for safety
        const operations = docs.map(doc => ({
          replaceOne: {
            filter: { _id: doc._id },
            replacement: doc,
            upsert: true
          }
        }));
        await targetColl.bulkWrite(operations);
        restoredCounts[collName] = docs.length;
      }
      
      // Cleanup shadow collection after successful restore
      await shadowColl.drop().catch(() => {});
    }

    // Mark as restored in audit log
    log.status = 'restored';
    await log.save();

    logger.info(`♻️  Data Restored from shadow collections [${timestamp}]`, restoredCounts);
    return ApiResponse.success(res, restoredCounts, 'System data successfully restored from backup!');
  } catch (error) {
    next(error);
  }
};

/**
 * 4. Get Available Restores (Within 30 Mins)
 */
exports.getAvailableRestores = async (req, res, next) => {
  try {
    const AuditLog = require('../models/AuditLog');
    
    const active = await AuditLog.find({ 
      action: 'DATA_RESET', 
      canRestoreUntil: { $gt: new Date() },
      status: { $ne: 'restored' }
    }).sort({ createdAt: -1 });

    const expired = await AuditLog.find({ 
      action: 'DATA_RESET', 
      $or: [
        { canRestoreUntil: { $lte: new Date() } },
        { status: 'cleaned' },
        { status: 'restored' }
      ]
    }).sort({ createdAt: -1 }).limit(15);

    return ApiResponse.success(res, { active, expired });
  } catch (error) {
    next(error);
  }
};
