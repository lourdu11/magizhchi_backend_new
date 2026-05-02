const Settings = require('../models/Settings');
const whatsapp = require('../services/whatsapp.service');
const logger = require('./logger');

/**
 * Smart Stock Alert System
 * 
 * Logic: 
 * 1. Checks if alerts are enabled in Settings.
 * 2. Compares old stock vs new stock to avoid spam.
 * 3. Triggers only when stock hits/crosses the threshold downwards.
 * 
 * @param {Object} item - The current inventory document (with virtuals)
 * @param {Number} oldStock - (Optional) The stock level before adjustment
 */
const checkAndAlertLowStock = async (item, oldStock = null) => {
  try {
    if (!item) return;
    const settings = await Settings.findOne();
    const isTest = item.productName?.includes('(SETTINGS TEST)');
    if (!isTest && !settings?.notifications?.lowStockAlert?.enabled) return;

    const threshold = item.lowStockThreshold || 5;
    
    // Use availableStock if provided directly (mock/test), else calculate
    const currentStock = item.availableStock !== undefined 
      ? item.availableStock 
      : Math.max(0, (item.totalStock || 0) - (item.onlineSold || 0) - (item.offlineSold || 0) - (item.reservedStock || 0) + (item.returned || 0) - (item.damaged || 0));

    let shouldSend = isTest || false;
    
    // If we have context of what it was before
    if (oldStock !== null) {
      // Alert when it FIRST hits or crosses the threshold
      if (oldStock > threshold && currentStock <= threshold) {
        shouldSend = true;
      }
      // Or when it hits zero exactly
      else if (oldStock > 0 && currentStock === 0) {
        shouldSend = true;
      }
    } else {
      // Fallback if no old stock context: only alert if it is currently low
      // Note: This might cause repeated alerts if called repeatedly without oldStock
      if (currentStock <= threshold) {
        shouldSend = true;
      }
    }

    if (shouldSend) {
      const { method } = settings.notifications.lowStockAlert;
      logger.info(`📢 Triggering Low Stock Alert [Test: ${isTest}] via ${method}`);
      
      if (method === 'whatsapp' || method === 'both') {
        try {
          logger.info(`📱 WhatsApp Stock Alert: ${item.productName} (${currentStock} left)`);
          await whatsapp.sendStockAlertToAdmin(item, currentStock);
        } catch (e) {
          logger.error(`❌ WhatsApp Test Alert Failed: ${e.message}`);
        }
      }

      if (method === 'email' || method === 'both') {
        try {
          const { alertEmail } = settings.notifications.email;
          const storeEmail = settings.store?.email || process.env.EMAIL_USER;
          const recipients = [...new Set([alertEmail, storeEmail].filter(Boolean))].join(', ');

          if (recipients) {
            logger.info(`📧 Email Stock Alert: Sending to ${recipients}`);
            const { sendLowStockEmail } = require('../services/email.service');
            await sendLowStockEmail(item, recipients);
          } else {
            logger.warn('⚠️ No email recipients found for stock alert');
          }
        } catch (e) {
          logger.error(`❌ Email Test Alert Failed: ${e.message}`);
        }
      }
    } else {
      logger.debug('⏭️ Stock level not low enough for alert (and not a test)');
    }
  } catch (error) {
    logger.error(`❌ Low stock check error: ${error.message}`);
  }
};

module.exports = { checkAndAlertLowStock };
