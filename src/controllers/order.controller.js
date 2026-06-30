const Order = require('../models/Order');
const User = require('../models/User');
const Product = require('../models/Product');
const Inventory = require('../models/Inventory');
const stockService = require('../services/stockService');
const { getIO } = require('../utils/socket');
const Coupon = require('../models/Coupon');
const Cart = require('../models/Cart');
const StockMovement = require('../models/StockMovement');
const StockService = require('../services/stock.service');
const { clearDashboardCache } = require('./admin.controller');
const Settings = require('../models/Settings');
const { razorpay, isConfigured: isRazorpayConfigured } = require('../config/razorpay');
const { sendOrderConfirmationEmail } = require('../services/email.service');
const { sendOrderNotificationToAdmin, sendOrderCancellationNotificationToAdmin, sendOrderReceiptToCustomer } = require('../services/whatsapp.service');
const { logAudit } = require('../utils/auditLogger');
const { normalizePhone } = require('../utils/normalize');
const ApiResponse = require('../utils/apiResponse');
const crypto = require('crypto');
const mongoose = require('mongoose');
const logger = require('../utils/logger');
const { startTransactionSession } = require('../utils/transaction');

const escapeRegex = value => String(value || '').replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');

const abortAndRespond = async (tx, respond) => {
  await tx.abortTransaction();
  await tx.endSession();
  return respond();
};

exports.reserveStock = async (req, res, next) => {
  try {
    const { items } = req.body;
    if (!items || !items.length) {
      return ApiResponse.error(res, 'No items provided', 400);
    }

    const results = [];
    for (const item of items) {
      const inv = await StockService.reserveStock(
        item.inventoryId, 
        Number(item.quantity),
        new mongoose.Types.ObjectId() // Dummy Order ID
      );
      results.push({
        inventoryId: inv._id,
        reservedStock: inv.reservedStock,
        expiresAt: inv.reservationExpiresAt
      });
    }

    return ApiResponse.success(res, { results }, 'Stock reserved successfully', 201);
  } catch (error) {
    next(error);
  }
};

// POST /orders/create
exports.createOrder = async (req, res, next) => {
  const tx = await startTransactionSession();
  const session = tx.session;
  try {
    const { items, shippingAddress, billingAddress, paymentMethod, couponCode, notes, guestDetails } = req.body;
    
    if (shippingAddress?.phone) shippingAddress.phone = normalizePhone(shippingAddress.phone);
    if (guestDetails?.phone) guestDetails.phone = normalizePhone(guestDetails.phone);
    
    // TASK 7: Empty Cart Block
    if (!items || items.length === 0) {
      return abortAndRespond(tx, () => ApiResponse.error(res, 'Order must have at least one item', 400));
    }
    if (!['cod', 'razorpay'].includes(paymentMethod)) {
      return abortAndRespond(tx, () => ApiResponse.error(res, 'Unsupported payment method', 400));
    }

    const settings = await Settings.findOne() || {};
    const shippingConfig = settings.shipping || { flatRateTN: 50, flatRateOut: 100, freeShippingThreshold: 999 };

    if (paymentMethod === 'cod') {
      if (settings?.payment?.codEnabled === false) {
        return abortAndRespond(tx, () => ApiResponse.error(res, 'Cash on Delivery is currently disabled.', 400));
      }
    }

    let subtotal = 0;
    const orderItems = [];

    // Pre-calculate total quantities per product ID to apply multi-buy promo pricing correctly
    const productQtyMap = {};
    for (const item of items) {
      if (item.productId) {
        productQtyMap[item.productId.toString()] = (productQtyMap[item.productId.toString()] || 0) + Number(item.quantity || 0);
      }
    }

    // 1. Build order items and check stock in Inventory
    for (const item of items) {
      const product = await Product.findById(item.productId);
      if (!product || !product.isActive) throw { message: `Product not available: ${item.productId}`, statusCode: 400 };

      // Helper to get aggregate stock and inventory ID for a variant
      const getAggregateStock = async (pRef, pName, size, color) => {
        const query = {
          $or: [
            { productRef: pRef, size: { $regex: new RegExp(`^${escapeRegex(size)}$`, 'i') }, color: { $regex: new RegExp(`^${escapeRegex(color)}$`, 'i') } },
            { productName: pName, size: { $regex: new RegExp(`^${escapeRegex(size)}$`, 'i') }, color: { $regex: new RegExp(`^${escapeRegex(color)}$`, 'i') } }
          ],
          onlineEnabled: true,
          isDeleted: false
        };
        const invItems = await Inventory.find(query).session(session);
        if (invItems.length === 0) return null;
        
        const totalAvailable = invItems.reduce((sum, inv) => {
          const avail = (inv.totalStock || 0) - (inv.onlineSold || 0) - (inv.offlineSold || 0) - (inv.reservedStock || 0) + (inv.returned || 0) - (inv.damaged || 0);
          return sum + Math.max(0, avail);
        }, 0);
        
        return { totalAvailable, inventoryId: invItems[0]._id, sku: invItems[0].sku, purchasePrice: invItems[0].purchasePrice };
      };

      let price = Number(product.discountedPrice || product.sellingPrice || 0);
      const qty = Number(item.quantity);
      
      console.log(`[ORDER DEBUG] Product: ${product.name}, Selling: ${product.sellingPrice}, Discounted: ${product.discountedPrice}, Final Price: ${price}`);

      if (!Number.isInteger(qty) || qty < 1) throw { message: `Invalid quantity for ${product.name}. Min 1 required.`, statusCode: 400 };

      // Secure Backend Multi-Buy Promo Price calculation
      if (product.multiBuyEnabled && product.multiBuyQuantity > 0 && product.multiBuyPrice > 0) {
        const totalProductQty = productQtyMap[product._id.toString()] || qty;
        const triggerQty = product.multiBuyQuantity;
        const promoPrice = product.multiBuyPrice;
        
        if (totalProductQty >= triggerQty) {
          const numBundles = Math.floor(totalProductQty / triggerQty);
          const remainderQty = totalProductQty % triggerQty;
          const totalPromoAmount = (numBundles * promoPrice) + (remainderQty * price);
          
          // Proportional average unit price
          const avgUnitPrice = totalPromoAmount / totalProductQty;
          price = parseFloat(avgUnitPrice.toFixed(2));
        }
      }

      const gstRate = Number(product.gstPercentage || 5) / 100;
      const taxableValue = parseFloat((price * qty / (1 + gstRate)).toFixed(2));
      const gstAmount = parseFloat((price * qty - taxableValue).toFixed(2));
      const itemTotal = parseFloat((price * qty).toFixed(2));
      
      console.log(`[ORDER DEBUG] Item Total: ${itemTotal}, Subtotal Before: ${subtotal}`);

      // ─── CASE A: COMBO PRODUCT ──────────────────────────────────
      if (item.isCombo || product.productNature === 'combo') {
        if (!item.comboSelections || !item.comboSelections.length) 
           throw { message: `Bundle configuration missing for ${product.name}`, statusCode: 400 };

        const selectionsWithInv = [];
        for (const selection of item.comboSelections) {
          const stock = await getAggregateStock(selection.productRef, selection.productName, selection.size, selection.color);
          if (!stock) throw { message: `Inventory not found for ${selection.productName} (${selection.size}/${selection.color})`, statusCode: 404 };
          if (stock.totalAvailable < qty) throw { message: `Insufficient stock for ${selection.productName} in bundle. Available: ${stock.totalAvailable}`, statusCode: 400 };
          
          selectionsWithInv.push({
            ...selection,
            inventoryId: stock.inventoryId,
            sku: stock.sku,
            purchasePrice: stock.purchasePrice || 0
          });
        }

        orderItems.push({
          productId: product._id, productName: product.name,
          productImage: product.images[0], sku: product.sku,
          hsnCode: product.hsnCode || '6205',
          isCombo: true, comboSelections: selectionsWithInv,
          quantity: qty, price,
          taxableValue, cgst: gstAmount / 2, sgst: gstAmount / 2, total: itemTotal,
        });
      }
      // ─── CASE B: STANDALONE PRODUCT ─────────────────────────────
      else {
        const stock = await getAggregateStock(product._id, product.name, item.size, item.color);
        if (!stock) throw { message: `Inventory not found for ${product.name} (${item.size}/${item.color})`, statusCode: 404 };
        if (stock.totalAvailable < qty) throw { message: `Insufficient stock for ${product.name}. Available: ${stock.totalAvailable}`, statusCode: 400 };

        orderItems.push({
          productId: product._id, productName: product.name,
          productImage: product.images[0], sku: stock.sku || product.sku,
          hsnCode: product.hsnCode || '6205',
          variant: { size: item.size, color: item.color },
          quantity: qty, price,
          purchasePrice: stock.purchasePrice || 0,
          taxableValue, cgst: gstAmount / 2, sgst: gstAmount / 2, total: itemTotal,
          inventoryId: stock.inventoryId
        });
      }
      
      subtotal = Math.round((subtotal * 100 + itemTotal * 100)) / 100;
    }

    // 2. Coupon logic
    let couponDiscount = 0;
    if (couponCode) {
      const coupon = await Coupon.findOne({ code: couponCode.toUpperCase(), isActive: true }).session(session);
      if (coupon && new Date() >= coupon.validFrom && new Date() <= coupon.validTo) {
        if (subtotal >= coupon.minPurchaseAmount) {
          couponDiscount = coupon.discountType === 'percentage' 
            ? Math.min((subtotal * (coupon.discountValue || 0)) / 100, coupon.maxDiscountAmount || Infinity)
            : Math.min(coupon.discountValue || 0, subtotal);
          
          const couponUpdate = { $inc: { usageCount: 1 } };
          if (req.user?._id) couponUpdate.$push = { usedBy: req.user._id };
          await Coupon.findByIdAndUpdate(coupon._id, couponUpdate).session(session);
        }
      }
    }

    const afterDiscount = subtotal - couponDiscount;
    const totalGst = orderItems.reduce((sum, item) => sum + (Number(item.cgst || 0) + Number(item.sgst || 0)), 0);
    const isTN = (shippingAddress?.state || '').toLowerCase().includes('tamil');
    const flatRate = isTN
      ? (shippingConfig.flatRateTN ?? shippingConfig.flatRate ?? 50)
      : (shippingConfig.flatRateOut ?? shippingConfig.flatRate ?? 100);
    const shipping = afterDiscount >= shippingConfig.freeShippingThreshold ? 0 : flatRate;
    const codCharges = paymentMethod === 'cod' ? Number(settings?.payment?.codCharges || 0) : 0;
    const codThreshold = Number(settings?.payment?.codThreshold ?? 50000);
    if (paymentMethod === 'cod' && subtotal > codThreshold) {
      return abortAndRespond(tx, () => ApiResponse.error(res, `Cash on Delivery is unavailable above Rs.${codThreshold}`, 400));
    }
    const totalAmount = parseFloat((afterDiscount + shipping + codCharges).toFixed(2));

    // 3. Final Stock Check before placement
    for (const item of orderItems) {
      if (item.isCombo) {
        for (const sel of item.comboSelections) {
           const inv = await Inventory.findById(sel.inventoryId).session(session);
           if (!inv) throw { message: `Inventory not found for ${sel.productName}`, statusCode: 404 };
           const available = (inv.totalStock || 0) - (inv.onlineSold || 0) - (inv.offlineSold || 0) - (inv.reservedStock || 0) + (inv.returned || 0) - (inv.damaged || 0);
           if (available < item.quantity) throw { message: `Stock just ran out for ${sel.productName} in bundle. Available: ${available}`, statusCode: 400 };
        }
      } else {
        const inv = await Inventory.findById(item.inventoryId).session(session);
        if (!inv) throw { message: `Inventory not found for ${item.productName}`, statusCode: 404 };
        const available = (inv.totalStock || 0) - (inv.onlineSold || 0) - (inv.offlineSold || 0) - (inv.reservedStock || 0) + (inv.returned || 0) - (inv.damaged || 0);
        if (available < item.quantity) throw { message: `Stock just ran out for ${item.productName}. Available: ${available}`, statusCode: 400 };
      }
    }

    // 4. Razorpay order
    let razorpayOrder = null;
    if (paymentMethod === 'razorpay') {
      if (settings?.payment?.onlineEnabled === false) throw { message: 'Online payment is currently disabled', statusCode: 400 };
      if (!isRazorpayConfigured) throw { message: 'Online payment unavailable', statusCode: 400 };
      razorpayOrder = await razorpay.orders.create({
        amount: Math.round(totalAmount * 100),
        currency: 'INR',
        receipt: `rcpt_${Date.now()}`,
      });
    }

    // 5. Generate Order Number
    const { getNextSequence } = require('../utils/generateNumbers');
    const seq = await getNextSequence('order', session);
    const adjustedSeq = seq < 1001 ? seq + 1000 : seq;
    const sequentialOrderNumber = `ORD-${adjustedSeq}`;

    const isGuest = !req.user || (req.user && req.user.name && req.user.name.startsWith('Guest_'));
    const finalGuestDetails = guestDetails || (isGuest && req.user ? {
      name: shippingAddress?.name || req.user.name,
      email: req.user.email,
      phone: shippingAddress?.phone || req.user.phone
    } : undefined);

    const checkoutAccessToken = crypto.randomBytes(32).toString('hex');
    const [order] = await Order.create([{
      orderNumber: sequentialOrderNumber,
      userId: req.user?._id || null,
      isGuestOrder: isGuest,
      guestDetails: finalGuestDetails,
      items: orderItems,
      pricing: { subtotal, couponDiscount, gstAmount: totalGst, shippingCharges: shipping, codCharges, totalAmount },
      shippingAddress, billingAddress: billingAddress || shippingAddress,
      paymentMethod,
      paymentStatus: 'pending',
      paymentDetails: razorpayOrder ? { razorpayOrderId: razorpayOrder.id } : {},
      checkoutAccessToken,
      couponCode, notes,
      statusHistory: [{ status: 'placed', updatedAt: new Date() }],
    }], { session });

    // 6. RESERVE STOCK (Single Source of Truth)
    const affectedProductIds = new Set();
    for (const item of order.items) {
      const selections = item.isCombo ? item.comboSelections : [{ inventoryId: item.inventoryId }];
      for (const sel of selections) {
         const result = await StockService.reserveStock(sel.inventoryId, item.quantity, order._id, session);
         if (result.productRef) affectedProductIds.add(result.productRef.toString());
      }
      if (item.isCombo && item.productId) affectedProductIds.add(item.productId.toString());
    }

    // 7. If COD, commit immediately.
    if (paymentMethod === 'cod') {
      await confirmStockSale(order.items, order._id, session);
      order.paymentStatus = 'cod_pending';
      await order.save({ session });
    }

    await tx.commitTransaction();
    await tx.endSession();

    // ── 8. POST-COMMIT GLOBAL SYNC ──
    const updatedStocks = [];
    for (const productId of affectedProductIds) {
      const stock = await stockService.syncProductStockSummary(productId);
      updatedStocks.push({ productId, ...stock });
    }
    const io = getIO();
    io.emit('stock:updated', { updatedStocks, orderId: order._id });

    // ── 9. CACHE INVALIDATION ──
    clearDashboardCache();

    if (req.user && paymentMethod === 'cod') {
      await Cart.findOneAndUpdate({ userId: req.user._id }, { items: [] });
    }

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

    logAudit({ req, action: 'CREATE_ORDER', module: 'ORDERS', resourceId: order._id, details: { orderNumber: order.orderNumber, total: totalAmount } });

    return ApiResponse.created(res, {
      order: { _id: order._id, orderNumber: order.orderNumber, totalAmount },
      checkoutAccessToken,
      razorpayOrder
    });
  } catch (error) { 
    await tx.abortTransaction();
    await tx.endSession();
    if (error.name === 'ValidationError') {
      console.error('CRITICAL_ORDER_VAL_FAIL:', JSON.stringify(error.errors, null, 2));
    }
    next(error); 
  }
};

exports.verifyPayment = async (req, res, next) => {
  const tx = await startTransactionSession();
  const session = tx.session;
  try {
    const { orderId, razorpayOrderId, razorpayPaymentId, razorpaySignature } = req.body;
    if (![orderId, razorpayOrderId, razorpayPaymentId, razorpaySignature].every(value => typeof value === 'string' && value)) {
      await tx.abortTransaction();
      await tx.endSession();
      return ApiResponse.error(res, 'Incomplete payment verification payload', 400);
    }

    const expectedSignature = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(`${razorpayOrderId}|${razorpayPaymentId}`).digest('hex');
    const actualSignatureBuffer = Buffer.from(razorpaySignature, 'utf8');
    const expectedSignatureBuffer = Buffer.from(expectedSignature, 'utf8');

    if (actualSignatureBuffer.length !== expectedSignatureBuffer.length || !crypto.timingSafeEqual(actualSignatureBuffer, expectedSignatureBuffer)) {
      await tx.abortTransaction();
      await tx.endSession();
      return ApiResponse.error(res, 'Verification failed', 400);
    }

    const orderQuery = Order.findById(orderId).select('+checkoutAccessToken');
    if (session) orderQuery.session(session);
    const order = await orderQuery;
    if (!order) {
      await tx.abortTransaction();
      await tx.endSession();
      return ApiResponse.notFound(res, 'Order not found');
    }
    if (order.paymentDetails?.razorpayOrderId !== razorpayOrderId) {
      await tx.abortTransaction();
      await tx.endSession();
      return ApiResponse.error(res, 'Payment does not belong to this order', 400);
    }
    if (order.paymentStatus === 'completed') {
      await tx.abortTransaction();
      await tx.endSession();
      return ApiResponse.success(res, { order: { orderNumber: order.orderNumber } }, 'Payment already verified');
    }
    if (order.paymentStatus !== 'pending' || order.orderStatus !== 'placed') {
      await tx.abortTransaction();
      await tx.endSession();
      return ApiResponse.error(res, 'Order is not awaiting payment', 409);
    }

    await confirmStockSale(order.items, order._id, session);
    order.paymentStatus = 'completed';
    order.paymentDetails = { ...order.paymentDetails, razorpayPaymentId, razorpaySignature, paidAt: new Date() };
    order.orderStatus = 'confirmed';
    order.statusHistory.push({ status: 'confirmed', updatedAt: new Date() });
    await order.save(session ? { session } : {});
    if (order.userId) {
      await Cart.findOneAndUpdate({ userId: order.userId }, { items: [] }, session ? { session } : {});
    }
    await tx.commitTransaction();
    await tx.endSession();

    return ApiResponse.success(res, { order: { orderNumber: order.orderNumber } }, 'Payment verified');
  } catch (error) {
    await tx.abortTransaction();
    await tx.endSession();
    next(error);
  }
};

async function confirmStockSale(items, orderId, session = null) {
  const quantitiesByInventory = getInventoryQuantities(items);
  for (const [inventoryId, quantity] of quantitiesByInventory) {
    await StockService.commitOnlineSale(inventoryId, quantity, orderId, session);
  }
}

function getInventoryQuantities(items) {
  const quantitiesByInventory = new Map();
  for (const item of items) {
    const selections = item.isCombo && item.comboSelections?.length
      ? item.comboSelections
      : [{ inventoryId: item.inventoryId }];
    for (const selection of selections) {
      const inventoryId = selection.inventoryId.toString();
      quantitiesByInventory.set(inventoryId, (quantitiesByInventory.get(inventoryId) || 0) + item.quantity);
    }
  }
  return quantitiesByInventory;
}

exports.cancelOrder = async (req, res, next) => {
  const tx = await startTransactionSession();
  const session = tx.session;
  try {
    const orderQuery = Order.findOne({ _id: req.params.id, userId: req.user._id });
    if (session) orderQuery.session(session);
    const order = await orderQuery;
    if (!order || !['placed', 'confirmed'].includes(order.orderStatus)) {
      await tx.abortTransaction();
      await tx.endSession();
      return ApiResponse.error(res, 'Cannot cancel order at this stage', 400);
    }

    for (const [inventoryId, quantity] of getInventoryQuantities(order.items)) {
      if (order.paymentStatus === 'pending') {
        await StockService.releaseReservation(inventoryId, quantity, order._id, session);
      } else if (['completed', 'cod_pending'].includes(order.paymentStatus)) {
        await StockService.rollbackSale(inventoryId, quantity, 'online', 'Order Cancelled', req.user._id, session);
      }
    }

    order.orderStatus = 'cancelled';
    order.cancelReason = req.body.reason || 'Cancelled by customer';
    order.statusHistory.push({ status: 'cancelled', updatedAt: new Date() });
    await order.save(session ? { session } : {});
    await tx.commitTransaction();
    await tx.endSession();

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
  } catch (error) {
    await tx.abortTransaction();
    await tx.endSession();
    next(error);
  }
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

    // TASK 8: Order Status Backwards Prevention
    const STATUS_RANK = {
      'placed': 1, 'pending': 1,
      'confirmed': 2, 'shipped': 3,
      'delivered': 4, 'cancelled': 5, 'returned': 5
    };
    const currentRank = STATUS_RANK[order.orderStatus] || 0;
    const newRank = STATUS_RANK[status] || 0;

    if (newRank < currentRank) {
      return ApiResponse.error(res, `Invalid transition: Cannot move status from ${order.orderStatus} back to ${status}`, 400);
    }

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
    
    // ─── CUSTOMER WHATSAPP NOTIFICATION ───
    if (status === 'delivered') {
      sendOrderReceiptToCustomer(order.shippingAddress.phone, order, 'online').catch(e => logger.error('Order Receipt WhatsApp Error:', e));
    }

    logAudit({ req, action: 'UPDATE_ORDER_STATUS', module: 'ORDERS', resourceId: order._id, details: { from: order.orderStatus, to: status, orderNumber: order.orderNumber } });

    return ApiResponse.success(res, { order }, 'Order status updated');
  } catch (error) { next(error); }
};

// POST /orders/:id/resend-receipt (Admin)
exports.resendReceipt = async (req, res, next) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return ApiResponse.notFound(res, 'Order not found');

    const results = { whatsapp: false, email: false };

    // 1. WhatsApp
    const phone = order.shippingAddress?.phone || order.userId?.phone;
    if (phone) {
      try {
        await sendOrderReceiptToCustomer(phone, order, 'online');
        results.whatsapp = true;
      } catch (err) { logger.error('Resend Order WhatsApp Error:', err); }
    }

    // 2. Email
    const email = order.guestDetails?.email || order.userId?.email || order.shippingAddress?.email;
    if (email) {
      try {
        const { sendOrderConfirmationEmail } = require('../services/email.service');
        await sendOrderConfirmationEmail(order);
        results.email = true;
      } catch (err) { logger.error('Resend Order Email Error:', err); }
    }

    if (!results.whatsapp && !results.email) {
      return ApiResponse.error(res, 'No contact details found or delivery failed', 400);
    }

    return ApiResponse.success(res, results, 'Receipt resent successfully');
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
  const tx = await startTransactionSession();
  const session = tx.session;
  try {
    const { status, adminNote, refundAmount } = req.body;
    if (!['pending', 'approved', 'rejected'].includes(status)) {
      return abortAndRespond(tx, () => ApiResponse.error(res, 'Invalid return status', 400));
    }
    const orderQuery = Order.findById(req.params.id);
    if (session) orderQuery.session(session);
    const order = await orderQuery;
    if (!order || !order.returnRequest?.isRequested) {
      return abortAndRespond(tx, () => ApiResponse.error(res, 'Return request not found', 404));
    }
    if (order.returnRequest.status === 'approved') {
      return abortAndRespond(tx, () => ApiResponse.error(res, 'This return has already been approved', 409));
    }

    order.returnRequest.status = status;
    order.returnRequest.adminNote = adminNote;

    if (status === 'approved') {
      order.orderStatus = 'returned';
      order.returnRequest.refundAmount = refundAmount || order.pricing.totalAmount;
      order.returnRequest.refundedAt = new Date();
      order.paymentStatus = 'refunded';

      for (const [inventoryId, quantity] of getInventoryQuantities(order.items)) {
        const inventory = await Inventory.findByIdAndUpdate(
          inventoryId,
          { $inc: { returned: quantity, availableStock: quantity } },
          { session, new: true }
        );
        if (!inventory) throw new Error(`Inventory ${inventoryId} was not found during return approval`);
        await StockMovement.create([{
          productId: inventory.productRef,
          inventoryId: inventory._id,
          variant: { size: inventory.size, color: inventory.color },
          type: 'return_customer',
          quantity,
          reason: adminNote || 'Customer Return Approved',
          orderId: order._id,
          referenceId: order._id,
          referenceModel: 'Order'
        }], session ? { session } : {});
        if (inventory.productRef) {
          const SyncService = require('../services/sync.service');
          await SyncService.syncProductStock(inventory.productRef, session);
        }
      }
    }

    await order.save(session ? { session } : {});
    await tx.commitTransaction();
    await tx.endSession();
    logAudit({ req, action: 'UPDATE_RETURN_STATUS', module: 'ORDERS', resourceId: order._id, details: { status, orderNumber: order.orderNumber } });

    return ApiResponse.success(res, order, `Return ${status}`);
  } catch (error) {
    await tx.abortTransaction();
    await tx.endSession();
    next(error);
  }
};

exports.handlePaymentFailed = async (req, res, next) => {
  try {
    const { orderId } = req.params;
    const order = await Order.findById(orderId);
    if (!order) {
      return ApiResponse.notFound(res, 'Order not found');
    }

    if (order.paymentStatus === 'pending') {
      logger.warn(`🛑 Payment failed/cancelled for Order ${order.orderNumber}. Rolling back stock.`);
      const StockService = require('../services/stock.service');
      await StockService.paymentFailureRollback(order._id);
      
      order.paymentStatus = 'failed';
      order.orderStatus = 'cancelled';
      order.cancelReason = 'Payment cancelled or failed at checkout';
      order.statusHistory.push({ status: 'cancelled', updatedAt: new Date(), note: 'Payment cancelled or failed at checkout' });
      await order.save();
    }

    return ApiResponse.success(res, { order: { orderNumber: order.orderNumber } }, 'Payment failure processed');
  } catch (error) {
    next(error);
  }
};

exports.retryPayment = async (req, res, next) => {
  try {
    const { id: orderId } = req.params;
    const order = await Order.findById(orderId);
    
    if (!order) {
      return ApiResponse.notFound(res, 'Order not found');
    }
    
    if (order.paymentStatus !== 'pending') {
      return ApiResponse.error(res, `Order payment is already ${order.paymentStatus}`, 400);
    }
    
    if (order.orderStatus === 'cancelled') {
      return ApiResponse.error(res, 'Order is cancelled and cannot be retried', 400);
    }

    if (order.paymentMethod !== 'razorpay') {
      return ApiResponse.error(res, 'Retry is only applicable for online payments', 400);
    }

    if (!isRazorpayConfigured) {
      return ApiResponse.error(res, 'Payment gateway is not configured', 503);
    }

    // Generate a new Razorpay Order for the same amount
    const options = {
      amount: Math.round(order.totalAmount * 100), // in paise
      currency: 'INR',
      receipt: `retry_${order.orderNumber}_${Date.now()}` // Ensure unique receipt
    };

    const razorpayOrder = await razorpay.orders.create(options);

    order.paymentRetryCount = (order.paymentRetryCount || 0) + 1;
    order.paymentDetails.razorpayOrderId = razorpayOrder.id; // Update razorpayOrderId for the retry
    await order.save();

    return ApiResponse.success(res, {
      order,
      razorpayOrder
    }, 'Payment retry initialized successfully');
  } catch (error) {
    logger.error('Payment retry error:', error);
    next(error);
  }
};

exports.abandonPayment = async (req, res, next) => {
  try {
    const { id: orderId } = req.params;
    const order = await Order.findById(orderId);
    
    if (!order) {
      return ApiResponse.notFound(res, 'Order not found');
    }

    if (order.paymentStatus === 'pending') {
      logger.warn(`🛑 Payment abandoned for Order ${order.orderNumber}.`);
      
      const retryCount = order.paymentRetryCount || 0;
      const customerName = order.guestDetails?.name || order.shippingAddress?.name || 'Customer';
      const customerPhone = order.guestDetails?.phone || order.shippingAddress?.phone || 'N/A';
      
      const adminMessage = `*PAYMENT ABANDONED*\n\nOrder: #${order.orderNumber}\nCustomer: ${customerName}\nPhone: ${customerPhone}\nAmount: Rs.${order.totalAmount}\nPayment Attempts: ${retryCount + 1}\n\nThe customer closed the payment window without paying.`;
      
      const { sendWhatsappMessage } = require('../services/whatsapp.service');
      const Settings = require('../models/Settings');
      const settings = await Settings.findOne();
      const adminPhones = settings?.notifications?.adminPhones || [];
      
      for (const phone of adminPhones) {
        if (phone) {
          sendWhatsappMessage(phone, adminMessage).catch(err => logger.error(`Failed to send WhatsApp to admin ${phone}`, err));
        }
      }
    }

    return ApiResponse.success(res, null, 'Payment abandonment logged');
  } catch (error) {
    logger.error('Abandon payment error:', error);
    next(error);
  }
};
