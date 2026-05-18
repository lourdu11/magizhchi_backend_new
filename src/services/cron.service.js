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

  logger.info('📅 CRON: Scheduled tasks initialized.');
};

module.exports = { initCronJobs };
