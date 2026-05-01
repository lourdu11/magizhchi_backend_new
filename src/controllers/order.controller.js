const Order = require('../models/Order');
const User = require('../models/User');
const Product = require('../models/Product');
const Inventory = require('../models/Inventory');
const Coupon = require('../models/Coupon');
const Cart = require('../models/Cart');
const StockMovement = require('../models/StockMovement');
const Settings = require('../models/Settings');
const { razorpay, isConfigured: isRazorpayConfigured } = require('../config/razorpay');
const { sendOrderConfirmationEmail } = require('../services/email.service');
const { sendOrderNotificationToAdmin, sendOrderCancellationNotificationToAdmin } = require('../services/whatsapp.service');
const ApiResponse = require('../utils/apiResponse');
const crypto = require('crypto');
const logger = require('../utils/logger');

// POST /orders/create
exports.createOrder = async (req, res, next) => {
  try {
    const { items, shippingAddress, billingAddress, paymentMethod, couponCode, notes, guestDetails } = req.body;

    const settings = await Settings.findOne() || {};
    const shippingConfig = settings.shipping || { flatRateTN: 50, flatRateOut: 100, freeShippingThreshold: 999 };

    if (paymentMethod === 'cod') {
      if (settings?.payment?.codEnabled === false) {
        return ApiResponse.error(res, 'Cash on Delivery is currently disabled.', 400);
      }
    }

    let subtotal = 0;
    const orderItems = [];

    // 1. Build order items and check stock in Inventory
    for (const item of items) {
      const product = await Product.findById(item.productId);
      if (!product || !product.isActive) throw { message: `Product not available: ${item.productId}`, statusCode: 400 };

      // Find matching Inventory row (case-insensitive)
      const invItem = await Inventory.findOne({
        productName: { $regex: new RegExp('^' + product.name.trim() + '$', 'i') },
        size: { $regex: new RegExp('^' + item.size.trim() + '$', 'i') },
        color: { $regex: new RegExp('^' + item.color.trim() + '$', 'i') },
        onlineEnabled: true
      });

      if (!invItem) throw { message: `Inventory not found for ${product.name} (${item.size}/${item.color})`, statusCode: 404 };

      // Formula for available: totalStock - onlineSold - offlineSold - reservedStock + returned - damaged
      const available = (invItem.totalStock || 0) - (invItem.onlineSold || 0) - (invItem.offlineSold || 0) - (invItem.reservedStock || 0) + (invItem.returned || 0) - (invItem.damaged || 0);
      if (available < item.quantity) throw { message: `Insufficient stock for ${product.name}`, statusCode: 400 };

      const price = Number(product.sellingPrice || invItem.sellingPrice || 0);
      const qty = Number(item.quantity || 1);
      const gstRate = Number(product.gstPercentage || 5) / 100;
      const taxableValue = parseFloat((price * qty / (1 + gstRate)).toFixed(2));
      const gstAmount = parseFloat((price * qty - taxableValue).toFixed(2));
      const itemTotal = price * qty;

      orderItems.push({
        productId: product._id, productName: product.name,
        productImage: product.images[0], sku: invItem.sku || product.sku,
        hsnCode: product.hsnCode || '6205',
        variant: { size: item.size, color: item.color },
        quantity: qty, price,
        taxableValue, cgst: gstAmount / 2, sgst: gstAmount / 2, total: itemTotal,
        inventoryId: invItem._id
      });
      subtotal += itemTotal;
    }

    // 2. Coupon logic
    let couponDiscount = 0;
    if (couponCode) {
      const coupon = await Coupon.findOne({ code: couponCode.toUpperCase(), isActive: true });
      if (coupon && new Date() >= coupon.validFrom && new Date() <= coupon.validTo) {
        if (subtotal >= coupon.minPurchaseAmount) {
          couponDiscount = coupon.discountType === 'percentage' 
            ? Math.min((subtotal * (coupon.discountValue || 0)) / 100, coupon.maxDiscountAmount || Infinity)
            : Math.min(coupon.discountValue || 0, subtotal);
          
          // Only push to usedBy if user is authenticated
          const couponUpdate = { $inc: { usageCount: 1 } };
          if (req.user?._id) couponUpdate.$push = { usedBy: req.user._id };
          await Coupon.findByIdAndUpdate(coupon._id, couponUpdate);
        }
      }
    }

    const afterDiscount = subtotal - couponDiscount;
    const totalGst = orderItems.reduce((sum, item) => sum + (Number(item.cgst || 0) + Number(item.sgst || 0)), 0);
    // Use state-based shipping rate (Tamil Nadu vs rest of India)
    const isTN = (shippingAddress?.state || '').toLowerCase().includes('tamil');
    const flatRate = isTN
      ? (shippingConfig.flatRateTN ?? shippingConfig.flatRate ?? 50)
      : (shippingConfig.flatRateOut ?? shippingConfig.flatRate ?? 100);
    const shipping = afterDiscount >= shippingConfig.freeShippingThreshold ? 0 : flatRate;
    const totalAmount = parseFloat((afterDiscount + shipping).toFixed(2));

    // 3. Reserve stock in Inventory (Atomic)
    for (const item of orderItems) {
      const reserveResult = await Inventory.updateOne(
        { 
          _id: item.inventoryId,
          $expr: {
            $gte: [
              { $subtract: [{ $add: ["$totalStock", "$returned"] }, { $add: ["$onlineSold", "$offlineSold", "$reservedStock", "$damaged"] }] },
              item.quantity
            ]
          }
        },
        { $inc: { reservedStock: item.quantity } }
      );

      if (reserveResult.modifiedCount === 0) {
        throw { message: `Stock collision for ${item.productName}. Please refresh.`, statusCode: 400 };
      }
    }

    // 4. Razorpay order
    let razorpayOrder = null;
    if (paymentMethod === 'razorpay') {
      if (!isRazorpayConfigured) throw { message: 'Online payment unavailable', statusCode: 400 };
      razorpayOrder = await razorpay.orders.create({
        amount: Math.round(totalAmount * 100),
        currency: 'INR',
        receipt: `rcpt_${Date.now()}`,
      });
    }

    // 5. Generate Global Sequential Order Number (10 digits padded)
    const totalOrders = await Order.countDocuments();
    const sequentialOrderNumber = `ORD-${String(totalOrders + 1).padStart(10, '0')}`;

    const order = await Order.create({
      orderNumber: sequentialOrderNumber,
      userId: req.user?._id || null,
      isGuestOrder: !req.user,
      guestDetails,
      items: orderItems,
      pricing: { subtotal, couponDiscount, gstAmount: totalGst, shippingCharges: shipping, totalAmount },
      shippingAddress, billingAddress: billingAddress || shippingAddress,
      paymentMethod,
      paymentStatus: 'pending',
      paymentDetails: razorpayOrder ? { razorpayOrderId: razorpayOrder.id } : {},
      couponCode, notes,
      statusHistory: [{ status: 'placed', updatedAt: new Date() }],
    });

    if (paymentMethod === 'cod') await confirmStockSale(order.items, order._id);

    if (req.user) await Cart.findOneAndUpdate({ userId: req.user._id }, { items: [] });

    const { sendAdminOrderNotificationEmail } = require('../services/email.service');
    const orderNotif = settings.notifications?.orderNotifications || { enabled: true, method: 'both' };
    
    if (orderNotif.enabled) {
      if (['whatsapp', 'both'].includes(orderNotif.method)) {
        sendOrderNotificationToAdmin(order).catch(e => logger.error('Order WhatsApp Alert Error:', e));
      }
      if (['email', 'both'].includes(orderNotif.method)) {
        sendAdminOrderNotificationEmail(order).catch(e => logger.error('Order Email Alert Error:', e));
      }
    }

    return ApiResponse.created(res, { order: { _id: order._id, orderNumber: order.orderNumber, totalAmount }, razorpayOrder });
  } catch (error) { 
    if (error.name === 'ValidationError') {
      console.error('CRITICAL_ORDER_VAL_FAIL:', JSON.stringify(error.errors, null, 2));
    }
    next(error); 
  }
};

exports.verifyPayment = async (req, res, next) => {
  try {
    const { orderId, razorpayOrderId, razorpayPaymentId, razorpaySignature } = req.body;
    const expectedSignature = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(`${razorpayOrderId}|${razorpayPaymentId}`).digest('hex');

    if (expectedSignature !== razorpaySignature) return ApiResponse.error(res, 'Verification failed', 400);

    const order = await Order.findById(orderId);
    if (!order) return ApiResponse.notFound(res, 'Order not found');

    order.paymentStatus = 'completed';
    order.paymentDetails = { ...order.paymentDetails, razorpayPaymentId, razorpaySignature, paidAt: new Date() };
    order.orderStatus = 'confirmed';
    order.statusHistory.push({ status: 'confirmed', updatedAt: new Date() });
    await order.save();

    await confirmStockSale(order.items, order._id);

    return ApiResponse.success(res, { order: { orderNumber: order.orderNumber } }, 'Payment verified');
  } catch (error) { next(error); }
};

async function confirmStockSale(items, orderId) {
  for (const item of items) {
    // inventoryId is stored in order items
    const updated = await Inventory.findByIdAndUpdate(item.inventoryId, {
      $inc: {
        onlineSold: item.quantity,
        reservedStock: -item.quantity
      }
    }, { new: true });
    
    // ─── LOW STOCK ALERT ───
    const { checkAndAlertLowStock } = require('../utils/lowStockAlert');
    checkAndAlertLowStock(updated).catch(() => {});

    await StockMovement.create({
      productId: item.productId, inventoryId: item.inventoryId,
      variant: item.variant, type: 'sale_online', quantity: item.quantity,
      reason: 'Online order sale', orderId,
    });
  }
}

exports.cancelOrder = async (req, res, next) => {
  try {
    const order = await Order.findOne({ _id: req.params.id, userId: req.user._id });
    if (!order || !['placed', 'confirmed'].includes(order.orderStatus)) {
      return ApiResponse.error(res, 'Cannot cancel order at this stage', 400);
    }

    for (const item of order.items) {
      if (order.orderStatus === 'placed') {
        // Was only reserved — free the reservation
        await Inventory.findByIdAndUpdate(item.inventoryId, { $inc: { reservedStock: -item.quantity } });
      } else if (order.orderStatus === 'confirmed') {
        // Stock was already moved to onlineSold — only reverse the sale
        await Inventory.findByIdAndUpdate(item.inventoryId, {
          $inc: { onlineSold: -item.quantity }
        });
      }
    }

    order.orderStatus = 'cancelled';
    order.cancelReason = req.body.reason || 'Cancelled by customer';
    order.statusHistory.push({ status: 'cancelled', updatedAt: new Date() });
    await order.save();

    const settings = await Settings.findOne() || {};
    const orderNotif = settings.notifications?.orderNotifications || { enabled: true, method: 'both' };

    const { sendAdminOrderCancellationEmail } = require('../services/email.service');
    
    if (orderNotif.enabled) {
      if (['whatsapp', 'both'].includes(orderNotif.method)) {
        sendOrderCancellationNotificationToAdmin(order, req.body.reason).catch(e => logger.error('Cancel WhatsApp Alert Error:', e));
      }
      if (['email', 'both'].includes(orderNotif.method)) {
        sendAdminOrderCancellationEmail(order, req.body.reason).catch(e => logger.error('Cancel Email Alert Error:', e));
      }
    }

    return ApiResponse.success(res, null, 'Order cancelled successfully');
  } catch (error) { next(error); }
};

// GET /orders/my-orders (User)
exports.getUserOrders = async (req, res, next) => {
  try {
    const { page = 1, limit = 10 } = req.query;
    const skip = (Number(page) - 1) * Number(limit);
    const [orders, total] = await Promise.all([
      Order.find({ userId: req.user._id }).sort({ createdAt: -1 }).skip(skip).limit(Number(limit)).lean(),
      Order.countDocuments({ userId: req.user._id }),
    ]);
    return ApiResponse.paginated(res, orders, { page: Number(page), limit: Number(limit), total, pages: Math.ceil(total / Number(limit)) });
  } catch (error) { next(error); }
};

// GET /orders/all (Admin)
exports.getAllOrders = async (req, res, next) => {
  try {
    const { page = 1, limit = 20, status, payment, search, startDate, endDate } = req.query;
    const query = {};
    if (status) query.orderStatus = status;
    if (payment) query.paymentStatus = payment;
    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) query.createdAt.$gte = new Date(startDate);
      if (endDate) query.createdAt.$lte = new Date(endDate);
    }
    if (search) query.$or = [
      { orderNumber: { $regex: search, $options: 'i' } },
      { 'shippingAddress.name': { $regex: search, $options: 'i' } },
      { 'shippingAddress.phone': { $regex: search, $options: 'i' } },
    ];
    const skip = (Number(page) - 1) * Number(limit);
    const [orders, total] = await Promise.all([
      Order.find(query).populate('userId', 'name email phone').sort({ createdAt: -1 }).skip(skip).limit(Number(limit)).lean(),
      Order.countDocuments(query),
    ]);
    return ApiResponse.paginated(res, orders, { page: Number(page), limit: Number(limit), total, pages: Math.ceil(total / Number(limit)) });
  } catch (error) { next(error); }
};

// GET /orders/:id (User or Admin)
exports.getOrder = async (req, res, next) => {
  try {
    const isAdmin = req.user?.role === 'admin';
    const query = isAdmin ? { _id: req.params.id } : { _id: req.params.id, userId: req.user._id };
    const order = await Order.findOne(query).populate('userId', 'name email phone');
    if (!order) return ApiResponse.notFound(res, 'Order not found');
    return ApiResponse.success(res, { order });
  } catch (error) { next(error); }
};

// PUT /orders/:id/status (Admin)
exports.updateOrderStatus = async (req, res, next) => {
  try {
    const { status, note, trackingNumber, carrier, trackingUrl } = req.body;
    const order = await Order.findById(req.params.id);
    if (!order) return ApiResponse.notFound(res, 'Order not found');

    order.orderStatus = status;
    order.statusHistory.push({ status, updatedAt: new Date(), updatedBy: req.user._id, note });
    if (trackingNumber) order.trackingInfo = { carrier, trackingNumber, trackingUrl };
    if (status === 'delivered') order.deliveredAt = new Date();

    // When admin manually confirms: move stock from reserved → sold
    const wasAlreadyConfirmed = order.statusHistory.some(
      h => h.status === 'confirmed' && h._id?.toString() !== order.statusHistory[order.statusHistory.length - 1]?._id?.toString()
    );
    if (status === 'confirmed' && order.paymentStatus !== 'completed' && !wasAlreadyConfirmed) {
      await confirmStockSale(order.items, order._id);
      order.paymentStatus = 'completed';
    }

    await order.save();
    return ApiResponse.success(res, { order }, 'Order status updated');
  } catch (error) { next(error); }
};

// POST /orders/:id/return (User)
exports.requestReturn = async (req, res, next) => {
  try {
    const { reason, images } = req.body;
    const order = await Order.findOne({ _id: req.params.id, userId: req.user._id });
    if (!order) return ApiResponse.notFound(res, 'Order not found');
    if (order.orderStatus !== 'delivered') return ApiResponse.error(res, 'Only delivered orders can be returned', 400);

    const deliveryDate = new Date(order.deliveredAt);
    const diffDays = Math.ceil((new Date() - deliveryDate) / (1000 * 60 * 60 * 24));
    if (diffDays > 7) return ApiResponse.error(res, 'Return window (7 days) has expired', 400);

    order.returnRequest = { isRequested: true, requestedAt: new Date(), reason, images: images || [], status: 'pending' };
    await order.save();
    return ApiResponse.success(res, order, 'Return request submitted');
  } catch (error) { next(error); }
};

// PUT /orders/:id/return-status (Admin)
exports.updateReturnStatus = async (req, res, next) => {
  try {
    const { status, adminNote, refundAmount } = req.body;
    const order = await Order.findById(req.params.id);
    if (!order || !order.returnRequest?.isRequested) return ApiResponse.error(res, 'Return request not found', 404);

    order.returnRequest.status = status;
    order.returnRequest.adminNote = adminNote;

    if (status === 'approved') {
      order.orderStatus = 'returned';
      order.returnRequest.refundAmount = refundAmount || order.pricing.totalAmount;
      order.returnRequest.refundedAt = new Date();
      order.paymentStatus = 'refunded';

      // Return stock to Inventory
      for (const item of order.items) {
        // Only increment 'returned' count. 
        // onlineSold remains as historical data, but 'returned' increases overall available pool.
        await Inventory.findByIdAndUpdate(item.inventoryId, { $inc: { returned: item.quantity } });
        await StockMovement.create({
          productId: item.productId, inventoryId: item.inventoryId,
          variant: item.variant, type: 'return_customer', quantity: item.quantity,
          reason: adminNote || 'Customer Return Approved', orderId: order._id,
        });
      }
    }

    await order.save();
    return ApiResponse.success(res, order, `Return ${status}`);
  } catch (error) { next(error); }
};

