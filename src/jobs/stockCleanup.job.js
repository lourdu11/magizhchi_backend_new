const cron = require('node-cron');
const StockService = require('../services/stock.service');
const logger = require('../utils/logger');

/**
 * Enterprise Stock Cleanup Job
 * Runs every 5 minutes to release expired reservations.
 */
const initStockCleanupJob = () => {
  logger.info('[JobManager] Initializing Stock Cleanup Job (5min interval)');

  // Run every 5 minutes
  cron.schedule('*/5 * * * *', async () => {
    try {
      logger.info('[JobManager] Executing: releaseExpiredReservations...');
      const result = await StockService.releaseExpiredReservations();
      if (result.releasedCount > 0) {
        logger.info(`[JobManager] Cleanup Success: Released ${result.releasedCount} units back to available stock.`);
      }
    } catch (error) {
      logger.error(`[JobManager] Cleanup Failed: ${error.message}`);
    }
  });
};

module.exports = initStockCleanupJob;
