const Order = require('../models/Order');
const StockService = require('../services/stock.service');
const logger = require('../utils/logger');

/**
 * Stock Cleanup Job
 * Releases expired reservations for unpaid online orders.
 */
const cleanupExpiredReservations = async () => {
    logger.info('[Job] Starting Stock Cleanup: Expired Reservations...');
    
    // Define expiration threshold (e.g., 2 hours ago)
    const expirationTime = new Date(Date.now() - 2 * 60 * 60 * 1000);
    
    try {
        const expiredOrders = await Order.find({
            orderStatus: 'placed',
            paymentStatus: 'pending',
            paymentMethod: 'razorpay',
            createdAt: { $lt: expirationTime }
        });

        if (expiredOrders.length === 0) {
            logger.info('[Job] No expired reservations found.');
            return;
        }

        logger.info(`[Job] Found ${expiredOrders.length} expired orders. Processing...`);

        for (const order of expiredOrders) {
            try {
                // 1. Release Stock
                for (const item of order.items) {
                    if (item.inventoryId) {
                        await StockService.releaseReservation(item.inventoryId, item.quantity);
                    }
                }

                // 2. Mark Order as Cancelled
                order.orderStatus = 'cancelled';
                order.cancelReason = 'System: Unpaid Reservation Expired';
                order.statusHistory.push({
                    status: 'cancelled',
                    updatedAt: new Date()
                });
                await order.save();

                logger.info(`[Job] Cancelled Order: ${order.orderNumber}`);
            } catch (err) {
                logger.error(`[Job] Error processing order ${order.orderNumber}:`, err);
            }
        }

        logger.info('[Job] Stock Cleanup completed successfully.');
    } catch (err) {
        logger.error('[Job] Critical Error in Stock Cleanup:', err);
    }
};

module.exports = { cleanupExpiredReservations };
