const StockService = require('../services/stock.service');
const logger = require('../utils/logger');

/**
 * Stock Cleanup Job
 * Releases expired reservations for unpaid online orders.
 */
const cleanupExpiredReservations = async () => {
    logger.info('[Job] Starting Stock Cleanup: Expired Reservations...');
    
    try {
        const result = await StockService.releaseExpiredReservations();
        if (result.releasedCount === 0) {
            logger.info('[Job] No expired reservations found.');
            return;
        }
        logger.info(`[Job] Stock Cleanup completed. Released ${result.releasedCount} units.`);
    } catch (err) {
        logger.error('[Job] Critical Error in Stock Cleanup:', err);
    }
};

module.exports = { cleanupExpiredReservations };
