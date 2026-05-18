const mongoose = require('mongoose');
const Bill = require('../models/Bill');
const { startTransactionSession } = require('../utils/transaction');
const Product = require('../models/Product');
const Inventory = require('../models/Inventory');
const User = require('../models/User');
const StockMovement = require('../models/StockMovement');
const StockService = require('../services/stock.service');
const { logAudit } = require('../utils/auditLogger');
const { normalizePhone } = require('../utils/normalize');
const ApiResponse = require('../utils/apiResponse');
const { sendOrderReceiptToCustomer } = require('../services/whatsapp.service');
const logger = require('../utils/logger');
const { clearDashboardCache } = require('./admin.controller');
const stockService = require('../services/stockService');
const { getIO } = require('../utils/socket');

// ── POST /bills ───────────────────────────────────────────────────────────────
exports.createBill = async (req, res, next) => {
  const tx = await startTransactionSession();
  const session = tx.session;
  try {
    const { idempotencyKey } = req.body;
    if (idempotencyKey) {
      const existing = await (session ? Bill.findOne({ idempotencyKey }).session(session) : Bill.findOne({ idempotencyKey }));
      if (existing) {
        await tx.abortTransaction();
        await tx.endSession();
        return ApiResponse.success(res, { bill: existing, duplicate: true }, 'Bill already exists (idempotency)');
      }
    }

    let { 
      items, customerDetails, paymentMethod, paymentDetails, 
      discount = 0, discountType = 'flat', roundOff = 0,
      taxType = 'regular', shopInfo, notes,
      billNumber: manualBillNumber,
      billDate: manualBillDate,
      salesStaffId
    } = req.body;

    if (customerDetails?.phone) {
      customerDetails.phone = normalizePhone(customerDetails.phone);
    }

    if (!items || items.length === 0) {
      await tx.abortTransaction();
      return ApiResponse.error(res, 'Bill must have at least one item', 400);
    }

    const billItems = [];
    let subtotalInPaise = 0;

    // ─── OPTIMIZED BATCH FETCH ───
    const itemsToFetch = [];
    items.forEach(i => {
      if (i.isCombo && i.comboSelections) {
        i.comboSelections.forEach(s => itemsToFetch.push({ ...s, quantity: i.quantity }));
      } else {
        itemsToFetch.push(i);
      }
    });

    const productIds = itemsToFetch.filter(i => i.productId && mongoose.Types.ObjectId.isValid(i.productId)).map(i => (i.productId || i.productRef).toString());
    const productNames = itemsToFetch.filter(i => !i.productId && !i.productRef).map(i => i.productName.trim());
    
    const inventoryIds = itemsToFetch
      .filter(i => i.inventoryId && mongoose.Types.ObjectId.isValid(i.inventoryId))
      .map(i => i.inventoryId.toString());

    const inventoryQueryOr = itemsToFetch.map(i => {
      const q = {
        productName: (i.productName || '').trim(),
        size: i.size || 'Free Size'
      };
      const colorVal = (i.color || '').trim();
      if (!colorVal || colorVal === 'Default') {
        return [
          { ...q, color: '' },
          { ...q, color: 'Default' }
        ];
      }
      return { ...q, color: colorVal };
    }).flat().filter(q => q.productName);

    const [productsBatch, inventoryBatch] = await Promise.all([
      session
        ? Product.find({ $or: [{ _id: { $in: productIds } }, { name: { $in: productNames.map(n => new RegExp('^' + n + '$', 'i')) } }] }).session(session)
        : Product.find({ $or: [{ _id: { $in: productIds } }, { name: { $in: productNames.map(n => new RegExp('^' + n + '$', 'i')) } }] }),
      session
        ? Inventory.find({ 
            $or: [
              { _id: { $in: inventoryIds } },
              ...inventoryQueryOr
            ]
          }).session(session)
        : Inventory.find({ 
            $or: [
              { _id: { $in: inventoryIds } },
              ...inventoryQueryOr
            ]
          })
    ]);

    const productMap = new Map();
    productsBatch.forEach(p => {
      productMap.set(p._id.toString(), p);
      productMap.set(p.name.toLowerCase(), p);
    });

    const inventoryMap = new Map();
    inventoryBatch.forEach(inv => {
      inventoryMap.set(inv._id.toString(), inv);
      const colorVal = (inv.color || '').trim();
      inventoryMap.set(`${inv.productName.toLowerCase()}|${inv.size}|${colorVal}`, inv);
      if (!colorVal || colorVal === 'Default') {
        inventoryMap.set(`${inv.productName.toLowerCase()}|${inv.size}|`, inv);
        inventoryMap.set(`${inv.productName.toLowerCase()}|${inv.size}|Default`, inv);
      }
    });

    for (const item of items) {
      if (item.isCombo) {
        // Handle Combo Item
        const selectionsWithInv = [];
        for (const sel of item.comboSelections || []) {
          const selColor = (sel.color || '').trim();
          let invItem = null;
          if (sel.inventoryId) {
            invItem = inventoryMap.get(sel.inventoryId.toString());
          }
          if (!invItem) {
            const invKey = `${sel.productName.toLowerCase()}|${sel.size}|${selColor}`;
            invItem = inventoryMap.get(invKey);
          }
          if (!invItem && (!selColor || selColor === 'Default')) {
            invItem = inventoryMap.get(`${sel.productName.toLowerCase()}|${sel.size}|`) || 
                      inventoryMap.get(`${sel.productName.toLowerCase()}|${sel.size}|Default`);
          }
          if (!invItem) {
            await tx.abortTransaction();
            return ApiResponse.error(res, `Component stock not found: ${sel.productName} (${sel.size})`, 404);
          }
          const currentStock = (invItem.totalStock || 0) - (invItem.offlineSold || 0) - (invItem.onlineSold || 0) - (invItem.damaged || 0) + (invItem.returned || 0) - (invItem.reservedStock || 0);
          // Allow negative stock for retail flex billing, shift burden to EOD reconciliation
          // if (currentStock < item.quantity) {
          //   await tx.abortTransaction();
          //   return ApiResponse.error(res, `Insufficient stock for combo component: ${sel.productName}. Available: ${currentStock}`, 400);
          // }
          selectionsWithInv.push({ ...sel, inventoryId: invItem._id });
        }

        const priceInPaise = Math.round((Number(item.price) || 0) * 100);
        const itemTotalInPaise = priceInPaise * item.quantity;
        
        billItems.push({
          productId: item.productId,
          productName: item.productName,
          sku: item.sku || 'COMBO',
          isCombo: true,
          comboSelections: selectionsWithInv,
          quantity: item.quantity,
          price: priceInPaise,
          total: itemTotalInPaise,
          taxableValue: itemTotalInPaise,
          cgst: 0, sgst: 0
        });
        subtotalInPaise += itemTotalInPaise;
      } else {
        // Handle Standalone Item
        const itemSize  = item.size  || 'Free Size';
        const itemColor = (item.color || '').trim();
        const itemProductName = item.productName.trim();

        let product = null;
        if (item.productId && mongoose.Types.ObjectId.isValid(item.productId)) {
          product = productMap.get(item.productId.toString());
        } else {
          product = productMap.get(itemProductName.toLowerCase());
        }

        let invItem = null;
        if (item.inventoryId) {
          invItem = inventoryMap.get(item.inventoryId.toString());
        }
        if (!invItem) {
          const invKey = `${itemProductName.toLowerCase()}|${itemSize}|${itemColor}`;
          invItem = inventoryMap.get(invKey);
        }
        if (!invItem && (!itemColor || itemColor === 'Default')) {
          invItem = inventoryMap.get(`${itemProductName.toLowerCase()}|${itemSize}|`) || 
                    inventoryMap.get(`${itemProductName.toLowerCase()}|${itemSize}|Default`);
        }

        if (!invItem) {
          // Self-healing: If inventory variant doesn't exist, create it on-the-fly with 0 stock!
          if (product) {
             invItem = await Inventory.create([{
                productRef: product._id,
                productName: product.name,
                size: itemSize,
                color: itemColor || 'Default',
                sku: product.sku ? `${product.sku}-${itemSize.toUpperCase()}-${(itemColor || 'Default').toUpperCase()}` : `AUTO-${Date.now()}`,
                sellingPrice: product.discountedPrice || product.sellingPrice || 0,
                costPrice: product.costPrice || 0,
                totalStock: 0,
                offlineEnabled: true,
                onlineEnabled: false
             }], { session: tx.session }).then(r => r[0]);
             
             // Register in map for subsequent lookups in same batch
             inventoryMap.set(invItem._id.toString(), invItem);
          } else {
             await tx.abortTransaction();
             return ApiResponse.error(res, `Stock record not found for ${item.productName} (${itemSize}/${itemColor || 'Default'})`, 404);
          }
        }

        const currentStock = (invItem.totalStock || 0) - (invItem.offlineSold || 0) - (invItem.onlineSold || 0) - (invItem.damaged || 0) + (invItem.returned || 0) - (invItem.reservedStock || 0);
        // Allow negative stock for retail flex billing, shift burden to EOD reconciliation
        // if (currentStock < item.quantity) {
        //   await tx.abortTransaction();
        //   return ApiResponse.error(res, `Insufficient stock for ${item.productName}. Available: ${currentStock}`, 400);
        // }

        const priceInPaise = Math.round((Number(item.price) || invItem.sellingPrice || product?.sellingPrice || 0) * 100);
        const itemTotalInPaise = priceInPaise * item.quantity;
        
        let taxableValueInPaise = itemTotalInPaise;
        let gstAmtInPaise = 0;
        
        if (taxType === 'regular' && product) {
          const gstRate = (invItem.gstPercentage || product.gstPercentage || 5) / 100;
          taxableValueInPaise = Math.round(itemTotalInPaise / (1 + gstRate));
          gstAmtInPaise = itemTotalInPaise - taxableValueInPaise;
        }

        const halfGstInPaise = Math.round(gstAmtInPaise / 2);

        billItems.push({
          productId: product?._id,
          productName: product?.name || item.productName,
          sku: invItem.sku || product?.sku || 'MANUAL',
          hsnCode: product?.hsnCode || '6205',
          inventoryId: invItem._id,
          variant: { size: itemSize, color: itemColor },
          quantity: item.quantity,
          price: priceInPaise,
          purchasePrice: Math.round((invItem.purchasePrice || 0) * 100),
          sellingPrice: Math.round((invItem.sellingPrice || 0) * 100),
          taxableValue: taxableValueInPaise,
          cgst: halfGstInPaise,
          sgst: halfGstInPaise,
          total: itemTotalInPaise,
        });

        subtotalInPaise += itemTotalInPaise;
      }
    }

    // TASK 10: Bill Number generation (Moved earlier for StockEngine reference)
    let billNumber = manualBillNumber;
    if (!billNumber || billNumber.startsWith('OFFLINE-')) {
      const currentYear = new Date().getFullYear();
      const { getNextSequence } = require('../utils/generateNumbers');
      const seq = await getNextSequence(`BILL-${currentYear}`, session);
      billNumber = `MAG-${currentYear}-${String(seq).padStart(3, '0')}`;
    }

    // ── 3. RESERVE & COMMIT STOCK (Atomic Cascade) ──
    const billId = new mongoose.Types.ObjectId();
    const affectedProductIds = new Set();
    
    for (const item of billItems) {
      if (item.isCombo) {
        // Combo Stock Cascade: Decrement each component's inventory
        for (const sel of item.comboSelections || []) {
          try {
            const result = await StockService.commitDirectOfflineSale(
              sel.inventoryId,
              item.quantity,
              billNumber,
              billId,
              req.user._id,
              session
            );
            if (result.productRef) affectedProductIds.add(result.productRef.toString());
          } catch (err) {
            await tx.abortTransaction();
            return ApiResponse.error(res, `Stock Error: ${err.message}`, 400);
          }
        }
        // Also add the combo product itself to sync list
        if (item.productId) affectedProductIds.add(item.productId.toString());
      } else {
        // Standalone Stock: Direct decrement
        try {
          const result = await StockService.commitDirectOfflineSale(
            item.inventoryId,
            item.quantity,
            billNumber,
            billId,
            req.user._id,
            session
          );
          if (result.productRef) affectedProductIds.add(result.productRef.toString());
        } catch (err) {
          await tx.abortTransaction();
          return ApiResponse.error(res, `Stock Error: ${err.message}`, 400);
        }
      }
    }

    // Pricing calculation
    let discAmtInPaise = Math.round(Number(discount) * 100);
    if (discountType === 'percentage') {
       discAmtInPaise = Math.round((subtotalInPaise * Number(discount)) / 100);
    } else if (discountType === 'offer') {
       discAmtInPaise = Number(discount) > 0 ? Math.round(Number(discount) * 100) : subtotalInPaise;
    }

    // TASK 3: Global Discount Cap Check (Simplified: check if total discount % exceeds a reasonable threshold like 50% if not specified)
    const totalDiscountPercent = (discAmtInPaise / subtotalInPaise) * 100;
    if (totalDiscountPercent > 99 && discountType !== 'offer') {
       await tx.abortTransaction();
       return ApiResponse.error(res, 'Suspiciously high global discount. Use Offer mode for 100% off.', 400);
    }

    const totalAmountInPaise = subtotalInPaise - discAmtInPaise + Math.round(Number(roundOff) * 100);
    const gstAmountInPaise = billItems.reduce((sum, i) => sum + (i.cgst + i.sgst), 0);

    // Commission
    const actualSalesStaffId = salesStaffId || req.user._id;
    const staff = await (session ? User.findById(actualSalesStaffId).session(session) : User.findById(actualSalesStaffId));
    const commissionAmountInPaise = Math.round((totalAmountInPaise * (staff?.commissionRate || 0)) / 100);

    const [bill] = await Bill.create([{
      _id: billId,
      billNumber,
      billDate: manualBillDate || new Date(),
      staffId: req.user._id,
      salesStaffId: actualSalesStaffId,
      commissionAmount: commissionAmountInPaise,
      customerDetails,
      items: billItems,
      taxType,
      pricing: { 
        subtotal: subtotalInPaise, 
        discount: discAmtInPaise, 
        discountType,
        gstAmount: gstAmountInPaise, 
        roundOff: Math.round(Number(roundOff) * 100),
        totalAmount: totalAmountInPaise 
      },
      paymentMethod,
      paymentDetails: paymentDetails || {},
      shopInfo,
      notes,
      idempotencyKey: idempotencyKey || (manualBillNumber && manualBillNumber.startsWith('OFFLINE-') ? manualBillNumber : undefined),
    }], session ? { session } : {});


    await tx.commitTransaction();
    await tx.endSession();

    // ── 5. POST-COMMIT GLOBAL SYNC & REAL-TIME BROADCAST ──
    const updatedStocks = [];
    for (const productId of affectedProductIds) {
      try {
        const stock = await stockService.syncProductStockSummary(productId);
        updatedStocks.push({ productId, ...stock });
      } catch (err) {
        logger.error(`[Sync] Failed to sync product ${productId}: ${err.message}`);
      }
    }

    // Broadcast update to all terminals
    const io = getIO();
    io.emit('STOCK_UPDATED', { updatedStocks, billId: bill._id });

    // ── 6. CACHE INVALIDATION ──
    clearDashboardCache();

    const populatedBill = await Bill.findById(bill._id).populate('items.productId', 'name images sku');

    // ─── CUSTOMER WHATSAPP NOTIFICATION ───
    if (populatedBill.customerDetails?.phone) {
      sendOrderReceiptToCustomer(populatedBill.customerDetails.phone, populatedBill, 'offline').catch(e => logger.error('Bill Receipt WhatsApp Error:', e));
    }

    logAudit({ req, action: 'CREATE_BILL', module: 'BILLING', resourceId: bill._id, details: { billNumber: bill.billNumber, total: totalAmountInPaise } });

    return ApiResponse.created(res, { bill: populatedBill }, 'Bill saved successfully');
  } catch (error) { 
    await tx.abortTransaction();
    await tx.endSession();
    next(error); 
  }
};

// ── GET /bills ────────────────────────────────────────────────────────────────
exports.getBills = async (req, res, next) => {
  try {
    const { lastId, limit = 20, date, search } = req.query;
    const query = {};
    if (req.user.role === 'staff') query.staffId = req.user._id;
    if (date) {
      const start = new Date(date); start.setHours(0, 0, 0, 0);
      const end   = new Date(date); end.setHours(23, 59, 59, 999);
      query.createdAt = { $gte: start, $lte: end };
    }
    if (search) {
      query.$or = [
        { billNumber:              { $regex: search, $options: 'i' } },
        { idempotencyKey:          { $regex: search, $options: 'i' } },
        { 'customerDetails.name':  { $regex: search, $options: 'i' } },
        { 'customerDetails.phone': { $regex: search, $options: 'i' } },
      ];
    }
    
    if (lastId) {
      query._id = { $lt: lastId }; // Sort is -createdAt, so use $lt for _id if created at same time or just use _id sort
    }

    const bills = await Bill.find(query)
      .populate('staffId', 'name')
      .populate('items.productId', 'name images sku')
      .sort({ createdAt: -1, _id: -1 })
      .limit(Number(limit) + 1)
      .lean();

    const hasMore = bills.length > Number(limit);
    const data = hasMore ? bills.slice(0, -1) : bills;
    const nextCursor = hasMore ? data[data.length - 1]._id : null;

    return ApiResponse.success(res, { 
      data, 
      nextCursor, 
      hasMore,
      total: await Bill.countDocuments(query) // Optional for progress bar
    });
  } catch (error) { next(error); }
};

// ── GET /bills/:id ────────────────────────────────────────────────────────────
exports.getBill = async (req, res, next) => {
  try {
    const query = { _id: req.params.id };
    if (req.user.role === 'staff') query.staffId = req.user._id;
    const bill = await Bill.findOne(query)
      .populate('staffId', 'name')
      .populate('items.productId', 'name images sku');
    if (!bill) return ApiResponse.notFound(res, 'Bill not found');
    return ApiResponse.success(res, { bill });
  } catch (error) { next(error); }
};

// ── GET /bills/daily-report ───────────────────────────────────────────────────
exports.getDailyReport = async (req, res, next) => {
  try {
    const date  = req.query.date ? new Date(req.query.date) : new Date();
    const start = new Date(date); start.setHours(0, 0, 0, 0);
    const end   = new Date(date); end.setHours(23, 59, 59, 999);
    const query = { createdAt: { $gte: start, $lte: end }, status: { $ne: 'voided' } };
    if (req.user.role === 'staff') query.staffId = req.user._id;

    const [bills, summary] = await Promise.all([
      Bill.find(query).sort({ createdAt: 1 }),
      Bill.aggregate([
        { $match: { ...query, status: { $ne: 'voided' } } },
        { $group: {
          _id: null,
          totalRevenue: { $sum: '$pricing.totalAmount' },
          totalBills:   { $sum: 1 },
          cashTotal:    { $sum: '$paymentDetails.cashAmount' },
          upiTotal:     { $sum: '$paymentDetails.upiAmount' },
          cardTotal:    { $sum: '$paymentDetails.cardAmount' },
        }},
      ]),
    ]);
    return ApiResponse.success(res, { bills, summary: summary[0] || {}, date: date.toDateString() });
  } catch (error) { next(error); }
};

// ── GET /bills/customer/:phone ─────────────────────────────────────────────────
exports.lookupCustomer = async (req, res, next) => {
  try {
    const { normalizePhone } = require('../utils/normalize');
    const phone = normalizePhone(req.params.phone);
    const user = await User.findOne({ phone }).select('name email phone wallet');
    if (!user) return ApiResponse.notFound(res, 'Customer not found');
    return ApiResponse.success(res, { customer: user });
  } catch (error) { next(error); }
};

// ── POST /bills/:id/resend-receipt ──────────────────────────────────────────
exports.resendReceipt = async (req, res, next) => {
  try {
    const bill = await Bill.findById(req.params.id).populate('items.productId', 'name images sku');
    if (!bill) return ApiResponse.notFound(res, 'Bill not found');

    const results = { whatsapp: false, email: false };

    // 1. WhatsApp
    if (bill.customerDetails?.phone) {
      try {
        await sendOrderReceiptToCustomer(bill.customerDetails.phone, bill, 'offline');
        results.whatsapp = true;
      } catch (err) { logger.error('Resend Bill WhatsApp Error:', err); }
    }

    // 2. Email
    if (bill.customerDetails?.email) {
      try {
        const { sendBillReceiptEmail } = require('../services/email.service');
        await sendBillReceiptEmail(bill);
        results.email = true;
      } catch (err) { logger.error('Resend Bill Email Error:', err); }
    }

    if (!results.whatsapp && !results.email) {
      return ApiResponse.error(res, 'No contact details found or delivery failed', 400);
    }

    return ApiResponse.success(res, results, 'Receipt resent successfully');
  } catch (error) { next(error); }
};

// ── DELETE /bills/:id ─────────────────────────────────────────────────────────
exports.deleteBill = async (req, res, next) => {
  const tx = await startTransactionSession();
  const session = tx.session;
  
  try {
    const { reason: userReason } = req.body;
    const bill = await (session ? Bill.findById(req.params.id).session(session) : Bill.findById(req.params.id));
    
    if (!bill) {
      await tx.abortTransaction();
      await tx.endSession();
      return ApiResponse.notFound(res, 'Bill not found');
    }

    if (bill.status === 'voided') {
      await tx.abortTransaction();
      await tx.endSession();
      return ApiResponse.error(res, 'This bill is already voided', 400);
    }

    // Reverse stock via Central Engine
    for (const item of bill.items) {
      const selections = item.isCombo ? item.comboSelections : [{ inventoryId: item.inventoryId }];
      for (const target of selections) {
        if (target.inventoryId) {
          await StockService.rollbackSale(
            target.inventoryId, 
            item.quantity, 
            'offline', 
            `Bill Voided: ${userReason || 'No reason'}`, 
            req.user._id,
            session
          );
        }
      }
    }

    // Soft Delete (Voiding)
    bill.status = 'voided';
    bill.voidedReason = userReason || 'No reason provided';
    bill.voidedBy = req.user._id;
    bill.voidedAt = new Date();
    await (session ? bill.save({ session }) : bill.save());
    
    await tx.commitTransaction();
    await tx.endSession();

    logAudit({ req, action: 'VOID_BILL', module: 'BILLING', resourceId: bill._id, details: { billNumber: bill.billNumber, reason: userReason } });
    return ApiResponse.success(res, null, 'Bill voided and stock restored');
  } catch (error) { 
    await tx.abortTransaction();
    await tx.endSession();
    next(error); 
  }
};

// ── PUT /bills/:id ─────────────────────────────────────────────────────────────
exports.updateBill = async (req, res, next) => {
  const tx = await startTransactionSession();
  const session = tx.session;
  try {
    const bill = await (session ? Bill.findById(req.params.id).session(session) : Bill.findById(req.params.id));
    if (!bill) {
      await tx.abortTransaction();
      return ApiResponse.notFound(res, 'Bill not found');
    }

    if (bill.status === 'voided') {
      await tx.abortTransaction();
      return ApiResponse.error(res, 'Cannot edit a voided bill', 400);
    }

    let { 
      items, customerDetails, paymentMethod, paymentDetails, 
      discount = 0, discountType = 'flat', roundOff = 0,
      taxType = 'regular', shopInfo, notes, salesStaffId
    } = req.body;

    if (!items || items.length === 0) {
      await tx.abortTransaction();
      return ApiResponse.error(res, 'Bill must have at least one item', 400);
    }

    // 1. REVERSE PREVIOUS STOCK (Within session)
    for (const item of bill.items) {
      const selections = item.isCombo ? item.comboSelections : [{ inventoryId: item.inventoryId }];
      for (const target of selections) {
        if (target.inventoryId) {
          await StockService.rollbackSale(
            target.inventoryId, 
            item.quantity, 
            'offline', 
            `Bill Modified (Reversal): ${bill.billNumber}`, 
            req.user._id, 
            session
          );
        }
      }
    }

    const billItems = [];
    let subtotalInPaise = 0;

    // ─── OPTIMIZED BATCH FETCH ───
    const itemsToFetch = [];
    items.forEach(i => {
      if (i.isCombo && i.comboSelections) {
        i.comboSelections.forEach(s => itemsToFetch.push({ ...s, quantity: i.quantity }));
      } else {
        itemsToFetch.push(i);
      }
    });

    const productIds = itemsToFetch.filter(i => i.productId && mongoose.Types.ObjectId.isValid(i.productId)).map(i => (i.productId || i.productRef).toString());
    const productNames = itemsToFetch.filter(i => !i.productId && !i.productRef).map(i => i.productName.trim());
    
    const inventoryQueryOr = itemsToFetch.map(i => ({
      productName: (i.productName || '').trim(),
      size: i.size || 'Free Size',
      color: i.color || 'Default'
    })).filter(q => q.productName);

    const [productsBatch, inventoryBatch] = await Promise.all([
      session
        ? Product.find({ $or: [{ _id: { $in: productIds } }, { name: { $in: productNames.map(n => new RegExp('^' + n + '$', 'i')) } }] }).session(session)
        : Product.find({ $or: [{ _id: { $in: productIds } }, { name: { $in: productNames.map(n => new RegExp('^' + n + '$', 'i')) } }] }),
      session
        ? Inventory.find({ $or: inventoryQueryOr }).session(session)
        : Inventory.find({ $or: inventoryQueryOr })
    ]);

    const productMap = new Map();
    productsBatch.forEach(p => {
      productMap.set(p._id.toString(), p);
      productMap.set(p.name.toLowerCase(), p);
    });

    const inventoryMap = new Map();
    inventoryBatch.forEach(inv => {
      const key = `${inv.productName.toLowerCase()}|${inv.size}|${inv.color}`;
      inventoryMap.set(key, inv);
    });

    for (const item of items) {
      if (item.isCombo) {
        // Handle Combo Item
        const selectionsWithInv = [];
        for (const sel of item.comboSelections || []) {
          const invKey = `${sel.productName.toLowerCase()}|${sel.size}|${sel.color}`;
          const invItem = inventoryMap.get(invKey);
          if (!invItem) {
            await tx.abortTransaction();
            return ApiResponse.error(res, `Component stock not found: ${sel.productName}`, 404);
          }
          const currentStock = (invItem.totalStock || 0) - (invItem.offlineSold || 0) - (invItem.onlineSold || 0) - (invItem.damaged || 0) + (invItem.returned || 0) - (invItem.reservedStock || 0);
          if (currentStock < item.quantity) {
            await tx.abortTransaction();
            return ApiResponse.error(res, `Insufficient stock for combo component: ${sel.productName}. Available: ${currentStock}`, 400);
          }
          selectionsWithInv.push({ ...sel, inventoryId: invItem._id });
        }

        const priceInPaise = Math.round((Number(item.price) || 0) * 100);
        const itemTotalInPaise = priceInPaise * item.quantity;
        
        billItems.push({
          productId: item.productId,
          productName: item.productName,
          sku: item.sku || 'COMBO',
          isCombo: true,
          comboSelections: selectionsWithInv,
          quantity: item.quantity,
          price: priceInPaise,
          total: itemTotalInPaise,
          taxableValue: itemTotalInPaise,
          cgst: 0, sgst: 0
        });
        subtotalInPaise += itemTotalInPaise;
      } else {
        // Handle Standalone Item
        const itemSize  = item.size  || 'Free Size';
        const itemColor = item.color || 'Default';
        const itemProductName = item.productName.trim();

        let product = null;
        if (item.productId && mongoose.Types.ObjectId.isValid(item.productId)) {
          product = productMap.get(item.productId.toString());
        } else {
          product = productMap.get(itemProductName.toLowerCase());
        }

        const invKey = `${itemProductName.toLowerCase()}|${itemSize}|${itemColor}`;
        const invItem = inventoryMap.get(invKey);

        if (!invItem) {
          await tx.abortTransaction();
          return ApiResponse.error(res, `Stock record not found for ${item.productName}`, 404);
        }

        const currentStock = (invItem.totalStock || 0) - (invItem.offlineSold || 0) - (invItem.onlineSold || 0) - (invItem.damaged || 0) + (invItem.returned || 0) - (invItem.reservedStock || 0);
        if (currentStock < item.quantity) {
          await tx.abortTransaction();
          return ApiResponse.error(res, `Insufficient stock for ${item.productName}. Available: ${currentStock}`, 400);
        }

        const priceInPaise = Math.round((Number(item.price) || invItem.sellingPrice || product?.sellingPrice || 0) * 100);
        const itemTotalInPaise = priceInPaise * item.quantity;
        
        let taxableValueInPaise = itemTotalInPaise;
        let gstAmtInPaise = 0;
        
        if (taxType === 'regular' && product) {
          const gstRate = (invItem.gstPercentage || product.gstPercentage || 5) / 100;
          taxableValueInPaise = Math.round(itemTotalInPaise / (1 + gstRate));
          gstAmtInPaise = itemTotalInPaise - taxableValueInPaise;
        }

        const halfGstInPaise = Math.round(gstAmtInPaise / 2);

        billItems.push({
          productId: product?._id,
          productName: product?.name || item.productName,
          sku: invItem.sku || product?.sku || 'MANUAL',
          hsnCode: product?.hsnCode || '6205',
          inventoryId: invItem._id,
          variant: { size: itemSize, color: itemColor },
          quantity: item.quantity,
          price: priceInPaise,
          purchasePrice: Math.round((invItem.purchasePrice || 0) * 100),
          sellingPrice: Math.round((invItem.sellingPrice || 0) * 100),
          taxableValue: taxableValueInPaise,
          cgst: halfGstInPaise,
          sgst: halfGstInPaise,
          total: itemTotalInPaise,
        });

        subtotalInPaise += itemTotalInPaise;
      }
    }

    // ── COMMIT NEW STOCK DEDUCTIONS ──
    for (const item of billItems) {
      const selections = item.isCombo ? item.comboSelections : [{ inventoryId: item.inventoryId }];
      for (const target of selections) {
        try {
          await StockService.commitDirectOfflineSale(
            target.inventoryId, 
            item.quantity, 
            bill.billNumber, 
            bill._id,
            req.user._id, 
            session
          );
        } catch (err) {
          await tx.abortTransaction();
          return ApiResponse.error(res, `Stock Error: ${err.message}`, 400);
        }
      }
    }

    // Pricing calculation
    let discAmtInPaise = Math.round(Number(discount) * 100);
    if (discountType === 'percentage') {
       discAmtInPaise = Math.round((subtotalInPaise * Number(discount)) / 100);
    } else if (discountType === 'offer') {
       discAmtInPaise = Number(discount) > 0 ? Math.round(Number(discount) * 100) : subtotalInPaise;
    }

    // TASK 3: Global Discount Cap Check
    const totalDiscountPercent = (discAmtInPaise / subtotalInPaise) * 100;
    if (totalDiscountPercent > 99 && discountType !== 'offer') {
       await tx.abortTransaction();
       return ApiResponse.error(res, 'Suspiciously high global discount. Use Offer mode for 100% off.', 400);
    }

    const totalAmountInPaise = subtotalInPaise - discAmtInPaise + Math.round(Number(roundOff) * 100);
    const gstAmountInPaise = billItems.reduce((sum, i) => sum + (i.cgst + i.sgst), 0);

    const actualSalesStaffId = salesStaffId || bill.salesStaffId || req.user._id;
    const staff = await (session ? User.findById(actualSalesStaffId).session(session) : User.findById(actualSalesStaffId));
    const commissionAmountInPaise = Math.round((totalAmountInPaise * (staff?.commissionRate || 0)) / 100);

    // 3. UPDATE BILL FIELDS
    bill.items = billItems;
    bill.customerDetails = customerDetails;
    bill.salesStaffId = actualSalesStaffId;
    bill.commissionAmount = commissionAmountInPaise;
    bill.taxType = taxType;
    bill.pricing = { 
      subtotal: subtotalInPaise, 
      discount: discAmtInPaise, 
      discountType,
      gstAmount: gstAmountInPaise, 
      roundOff: Math.round(Number(roundOff) * 100),
      totalAmount: totalAmountInPaise 
    };
    bill.paymentMethod = paymentMethod;
    bill.paymentDetails = paymentDetails || {};
    bill.shopInfo = shopInfo;
    bill.notes = notes || bill.notes;

    await (session ? bill.save({ session }) : bill.save());
    await tx.commitTransaction();
    await tx.endSession();

    await bill.populate('items.productId', 'name images sku');

    if (bill.customerDetails?.phone) {
      sendOrderReceiptToCustomer(bill.customerDetails.phone, bill, 'offline').catch(() => {});
    }

    logAudit({ req, action: 'UPDATE_BILL', module: 'BILLING', resourceId: bill._id, details: { billNumber: bill.billNumber, total: totalAmountInPaise } });

    clearDashboardCache();

    return ApiResponse.success(res, { bill }, 'Bill updated successfully');
  } catch (error) { 
    await tx.abortTransaction();
    await tx.endSession();
    next(error); 
  }
};
// ── GET /bills/staff-stats ────────────────────────────────────────────────────
exports.getStaffDailyStats = async (req, res, next) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const stats = await Bill.aggregate([
      {
        $match: {
          staffId: req.user._id,
          createdAt: { $gte: today },
          status: 'active'
        }
      },
      {
        $group: {
          _id: null,
          sessionTotal: { $sum: '$pricing.totalAmount' },
          billCount: { $sum: 1 }
        }
      }
    ]);

    return ApiResponse.success(res, {
      sessionTotal: stats[0]?.sessionTotal || 0,
      billCount: stats[0]?.billCount || 0
    });
  } catch (error) { next(error); }
};
