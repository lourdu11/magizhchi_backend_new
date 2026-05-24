const cron = require('node-cron');
const Order = require('../models/Order');
const Inventory = require('../models/Inventory');
const logger = require('../utils/logger');

/**
 * Initializes all scheduled background tasks
 */
const initCronJobs = () => {
  // ─── 1. Abandoned Checkout Cleanup (Every 5 minutes) ──────────
  // Authoritative cleanup via Stock Engine
  cron.schedule('*/5 * * * *', async () => {
    logger.info('🧹 CRON: Starting Enterprise Stock Release...');
    try {
      const StockService = require('./stock.service');
      const result = await StockService.releaseExpiredReservations();
      if (result.releasedCount > 0) {
        logger.info(`✅ CRON: Released ${result.releasedCount} expired units back to inventory.`);
      }
    } catch (error) {
      logger.error(`🔥 CRON ERROR (Stock Release): ${error.message}`);
    }
  });

  // ─── 2. System Consistency Audit (Every 6 hours) ──────────
  cron.schedule('0 */6 * * *', async () => {
    logger.info('🔍 CRON: Starting System Consistency Audit...');
    try {
      const SyncService = require('./sync.service');
      const results = await SyncService.runAuditAndRepair();
      logger.info(`✅ CRON: Audit Complete. Fixed ${results.fixed} mappings. Orphans remaining: ${results.orphanedInventory}`);
    } catch (error) {
      logger.error(`🔥 CRON ERROR (Audit): ${error.message}`);
    }
  });

  // ─── 3. Shadow Data Reset Cleanup (Every 15 minutes) ──────────
  cron.schedule('*/15 * * * *', async () => {
    logger.info('🧹 CRON: Checking for expired Data Reset shadow collections...');
    try {
      const AuditLog = require('../models/AuditLog');
      const mongoose = require('mongoose');
      const db = mongoose.connection.db;

      const expiredLogs = await AuditLog.find({
        action: 'DATA_RESET',
        canRestoreUntil: { $lte: new Date() },
        status: { $ne: 'cleaned' } // Only clean those that haven't been swept
      });

      for (const log of expiredLogs) {
        if (log.details && log.details.timestamp) {
          const ts = log.details.timestamp;
          const collections = Object.keys(log.documentsCounts || {});
          
          for (const collName of collections) {
            const shadowName = `${collName}_deleted_${ts}`;
            await db.collection(shadowName).drop().catch(() => {});
          }
        }
        log.status = 'cleaned';
        await log.save();
        logger.info(`✅ CRON: Permanently dropped expired shadow data for reset ID: ${log._id}`);
      }
    } catch (error) {
      logger.error(`🔥 CRON ERROR (Shadow Cleanup): ${error.message}`);
    }
  });

  // ─── 4. Keep-Alive Self-Ping (Every 14 minutes) ──────────
  // Prevents Render from spinning down the free tier backend
  cron.schedule('*/14 * * * *', async () => {
    logger.info('🔄 CRON: Keep-alive ping to prevent Render sleep...');
    try {
      const axios = require('axios');
      const backendUrl = process.env.BACKEND_URL || 'https://magizhchi-backend-28sx.onrender.com';
      await axios.get(`${backendUrl}/api/v1/health`);
      logger.info('✅ CRON: Keep-alive ping successful.');
    } catch (error) {
      logger.error(`🔥 CRON ERROR (Keep-alive): ${error.message}`);
    }
  });

  logger.info('📅 CRON: Scheduled tasks initialized.');
};

module.exports = { initCronJobs };
