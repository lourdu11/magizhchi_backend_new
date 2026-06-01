const crypto = require('crypto');
const Order = require('../models/Order');
const Cart = require('../models/Cart');
const Inventory = require('../models/Inventory');
const StockMovement = require('../models/StockMovement');
const { sendOrderConfirmationEmail } = require('../services/email.service');
const { sendOrderNotificationToAdmin } = require('../services/whatsapp.service');
const logger = require('../utils/logger');
const { startTransactionSession } = require('../utils/transaction');

const confirmStockSale = async (items, orderId, session = null) => {
  const StockService = require('../services/stock.service');
  const quantitiesByInventory = new Map();
  for (const item of items) {
    const selections = item.isCombo ? item.comboSelections : [{ inventoryId: item.inventoryId }];
    for (const selection of selections) {
      const inventoryId = selection.inventoryId.toString();
      quantitiesByInventory.set(inventoryId, (quantitiesByInventory.get(inventoryId) || 0) + item.quantity);
    }
  }
  for (const [inventoryId, quantity] of quantitiesByInventory) {
    await StockService.commitOnlineSale(inventoryId, quantity, orderId, session);
  }
};

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

    const signatureBuffer = Buffer.from(signature || '', 'utf8');
    const expectedBuffer = Buffer.from(expectedSignature, 'utf8');

    if (signatureBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)) {
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

      const tx = await startTransactionSession();
      const session = tx.session;
      let order;
      try {
        const orderQuery = Order.findOne({ 'paymentDetails.razorpayOrderId': razorpayOrderId });
        if (session) orderQuery.session(session);
        order = await orderQuery;

        if (!order) {
          await tx.abortTransaction();
          await tx.endSession();
        logger.error(`❌ Webhook Error: Order not found for Razorpay Order ID: ${razorpayOrderId}`);
        return res.status(404).json({ status: 'error', message: 'Order not found' });
        }

      // Idempotency check: If already completed, just return 200
        if (order.paymentStatus === 'completed') {
          await tx.abortTransaction();
          await tx.endSession();
        logger.info(`ℹ️ Webhook: Order ${order.orderNumber} already marked as paid. Skipping.`);
        return res.status(200).json({ status: 'ok', message: 'Already processed' });
        }

        if (order.paymentStatus !== 'pending' || order.orderStatus !== 'placed') {
          await tx.abortTransaction();
          await tx.endSession();
          return res.status(200).json({ status: 'ok', message: 'Order no longer awaiting payment' });
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
        
          await confirmStockSale(order.items, order._id, session);
        }

        await order.save(session ? { session } : {});
        if (order.userId) {
          await Cart.findOneAndUpdate({ userId: order.userId }, { items: [] }, session ? { session } : {});
        }
        await tx.commitTransaction();
        await tx.endSession();
      } catch (error) {
        await tx.abortTransaction();
        await tx.endSession();
        throw error;
      }
      logger.info(`✅ Webhook: Order ${order.orderNumber} successfully updated to PAID.`);

      // Send Notifications
      try {
        sendOrderConfirmationEmail(order).catch(e => logger.error('Webhook Email Error:', e));
        sendOrderNotificationToAdmin(order).catch(e => logger.error('Webhook WhatsApp Error:', e));
      } catch (notifErr) {
        logger.error('Webhook Notification Trigger Error:', notifErr);
      }
    }

    // 🛡️ NEW: Handle Payment Failure (Phase 2 Hardening)
    if (event === 'payment.failed') {
      const paymentEntity = payload.payment.entity;
      const razorpayOrderId = paymentEntity.order_id;
      const tx = await startTransactionSession();
      const session = tx.session;
      
      try {
        const orderQuery = Order.findOne({ 'paymentDetails.razorpayOrderId': razorpayOrderId });
        if (session) orderQuery.session(session);
        const order = await orderQuery;
        if (order && order.paymentStatus === 'pending') {
         logger.warn(`🛑 Webhook: Payment failed for Order ${order.orderNumber}. Rolling back stock.`);
         const StockService = require('../services/stock.service');
         await StockService.paymentFailureRollback(order._id, session);
         
         order.paymentStatus = 'failed';
         order.orderStatus = 'cancelled';
         order.cancelReason = 'Payment Failed (Webhook)';
         order.statusHistory.push({ status: 'cancelled', updatedAt: new Date(), note: 'Payment failed at gateway.' });
         await order.save(session ? { session } : {});
        }
        await tx.commitTransaction();
      } catch (error) {
        await tx.abortTransaction();
        throw error;
      } finally {
        await tx.endSession();
      }
    }

    // Always return 200 to Razorpay
    res.status(200).json({ status: 'ok' });
  } catch (error) {
    logger.error('💥 Webhook Processing Crash:', error);
    res.status(500).json({ status: 'error', message: error.message });
  }
};
