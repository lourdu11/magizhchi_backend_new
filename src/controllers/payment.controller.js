const crypto = require('crypto');
const Order = require('../models/Order');
const Inventory = require('../models/Inventory');
const StockMovement = require('../models/StockMovement');
const { sendOrderConfirmationEmail } = require('../services/email.service');
const { sendOrderNotificationToAdmin } = require('../services/whatsapp.service');
const logger = require('../utils/logger');

/**
 * RAZORPAY WEBHOOK HANDLER
 * Ensures payment status is updated even if user closes browser before redirect.
 */
exports.handleWebhook = async (req, res) => {
  try {
    const signature = req.headers['x-razorpay-signature'];
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;

    if (!secret) {
      logger.error('❌ Webhook Error: RAZORPAY_WEBHOOK_SECRET is not configured.');
      return res.status(500).json({ status: 'error', message: 'Webhook secret missing' });
    }

    // CRITICAL: req.body is a Buffer from express.raw() middleware.
    // Razorpay signature must be verified against the raw body bytes directly.
    const rawBody = req.body; // Buffer
    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(rawBody)
      .digest('hex');

    if (signature !== expectedSignature) {
      logger.warn('⚠️ Webhook Error: Invalid signature received.');
      return res.status(400).json({ status: 'error', message: 'Invalid signature' });
    }

    // Parse the JSON body AFTER signature verification
    let webhookBody;
    try {
      webhookBody = JSON.parse(rawBody.toString('utf8'));
    } catch (parseErr) {
      logger.error('❌ Webhook Error: Failed to parse body JSON.');
      return res.status(400).json({ status: 'error', message: 'Invalid JSON body' });
    }

    const event = webhookBody.event;
    const payload = webhookBody.payload;

    logger.info(`🔔 Razorpay Webhook Received: ${event}`);

    // We primarily care about payment.captured or order.paid
    if (event === 'payment.captured' || event === 'order.paid') {
      const paymentEntity = payload.payment.entity;
      const razorpayOrderId = paymentEntity.order_id;
      const razorpayPaymentId = paymentEntity.id;

      // Find order by Razorpay Order ID
      const order = await Order.findOne({ 'paymentDetails.razorpayOrderId': razorpayOrderId });

      if (!order) {
        logger.error(`❌ Webhook Error: Order not found for Razorpay Order ID: ${razorpayOrderId}`);
        return res.status(404).json({ status: 'error', message: 'Order not found' });
      }

      // Idempotency check: If already completed, just return 200
      if (order.paymentStatus === 'completed') {
        logger.info(`ℹ️ Webhook: Order ${order.orderNumber} already marked as paid. Skipping.`);
        return res.status(200).json({ status: 'ok', message: 'Already processed' });
      }

      // Update Order Status
      order.paymentStatus = 'completed';
      order.paymentDetails = {
        ...order.paymentDetails,
        razorpayPaymentId,
        paidAt: new Date(),
        webhookCaptured: true
      };
      
      // Only move to 'confirmed' if it was still 'placed' or 'pending'
      if (['placed', 'pending'].includes(order.orderStatus)) {
        order.orderStatus = 'confirmed';
        order.statusHistory.push({ status: 'confirmed', updatedAt: new Date(), note: 'Payment captured via Webhook' });
        
        // Confirm Stock Sale (move from reserved to onlineSold)
        await confirmStockSale(order.items, order._id);
      }

      await order.save();
      logger.info(`✅ Webhook: Order ${order.orderNumber} successfully updated to PAID.`);

      // Send Notifications (wrapped in try/catch to ensure 200 is still sent to Razorpay)
      try {
        sendOrderConfirmationEmail(order).catch(e => logger.error('Webhook Email Error:', e));
        sendOrderNotificationToAdmin(order).catch(e => logger.error('Webhook WhatsApp Error:', e));
      } catch (notifErr) {
        logger.error('Webhook Notification Trigger Error:', notifErr);
      }
    }

    // Always return 200 to Razorpay
    res.status(200).json({ status: 'ok' });
  } catch (error) {
    logger.error('💥 Webhook Processing Crash:', error);
    res.status(500).json({ status: 'error', message: error.message });
  }
};

/**
 * Re-uses the stock confirmation logic from order controller
 */
async function confirmStockSale(items, orderId) {
  for (const item of items) {
    try {
      const updated = await Inventory.findByIdAndUpdate(item.inventoryId, {
        $inc: {
          onlineSold: item.quantity,
          reservedStock: -item.quantity
        }
      }, { new: true });
      
      const { checkAndAlertLowStock } = require('../utils/lowStockAlert');
      checkAndAlertLowStock(updated).catch(() => {});

      await StockMovement.create({
        productId: item.productId, inventoryId: item.inventoryId,
        variant: item.variant, type: 'sale_online', quantity: item.quantity,
        reason: 'Online order sale (Webhook Verified)', orderId,
      });
    } catch (err) {
      logger.error(`Failed to confirm stock for item in order ${orderId}:`, err);
    }
  }
}
