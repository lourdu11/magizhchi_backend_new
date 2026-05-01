const Purchase = require('../models/Purchase');
const Supplier = require('../models/Supplier');
const Inventory = require('../models/Inventory');
const StockMovement = require('../models/StockMovement');
const ApiResponse = require('../utils/apiResponse');

// ── POST /admin/purchases ─────────────────────────────────────────────────────
exports.createPurchase = async (req, res, next) => {
  try {
    const { supplierId, supplierName, billNumber, items, pricing, paymentStatus, status, paidAmount, purchaseDate, notes } = req.body;

    if (!items || items.length === 0) {
      return ApiResponse.error(res, 'At least one item is required', 400);
    }

    // 1. Generate Purchase Number
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const todayEnd   = new Date(); todayEnd.setHours(23, 59, 59, 999);
    const countToday = await Purchase.countDocuments({ createdAt: { $gte: todayStart, $lte: todayEnd } });
    const sequence   = (countToday + 1).toString().padStart(3, '0');
    const dateStr    = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const purchaseNumber = `PUR-${dateStr}-${sequence}`;

    // 2. Auto-calculate pricing from items (backend source of truth)
    let subtotal = 0;
    const processedItems = items.map(item => {
      const qty   = Number(item.quantity) || 0;
      const cost  = Number(item.costPrice) || 0;
      const lineTotal = qty * cost;
      subtotal  += lineTotal;
      return { ...item, total: lineTotal, gstPercent: 0 };
    });
    const gstAmount = 0;
    const totalAmount = subtotal;

    // 3. Save purchase bill
    const purchase = await Purchase.create({
      purchaseNumber,
      billNumber:   billNumber || '',
      supplierName: supplierName || '',
      supplierId:   supplierId || null,
      items:        processedItems,
      pricing:      { subtotal, gstAmount, totalAmount },
      status:       status || 'received',
      paidAmount:   Number(paidAmount) || 0,
      paymentStatus: paymentStatus || 'pending',
      purchaseDate:  purchaseDate || new Date(),
      notes,
      performedBy: req.user._id,
    });

    // 4. Update Inventory & Supplier ONLY if received
    if (purchase.status === 'received') {
      // A. Update Supplier Ledger
      if (supplierId) {
        const supplierUpdate = {
          $inc: { 
            totalPurchaseAmount: totalAmount,
            totalPaidAmount: Number(paidAmount) || 0 
          }
        };

        if (Number(paidAmount) > 0) {
          supplierUpdate.$push = { 
            payments: { 
              amount: Number(paidAmount), 
              method: 'Purchase Settlement', 
              referenceId: purchaseNumber, 
              note: `Direct payment for ${purchaseNumber}`,
              date: purchaseDate || new Date() 
            }
          };
        }

        await Supplier.findByIdAndUpdate(supplierId, supplierUpdate);
      }

      // B. Update Inventory for each item
      await syncPurchaseToInventory(purchase, req.user._id);
    }

    return ApiResponse.created(res, { purchase }, 'Purchase recorded successfully');
  } catch (error) { next(error); }
};

// ── PUT /admin/purchases/:id ──────────────────────────────────────────────────
exports.updatePurchase = async (req, res, next) => {
  try {
    const { id } = req.params;
    const oldPurchase = await Purchase.findById(id);
    if (!oldPurchase) return ApiResponse.notFound(res, 'Purchase not found');

    const { supplierId, supplierName, billNumber, paymentStatus, status, paidAmount, purchaseDate, notes, items } = req.body;

    // 1. Rollback old stock if it was already received
    if (oldPurchase.status === 'received') {
      await rollbackPurchaseInventory(oldPurchase, req.user._id);
      
      // Rollback Supplier Ledger
      if (oldPurchase.supplierId) {
        await Supplier.findByIdAndUpdate(oldPurchase.supplierId, {
          $inc: { 
            totalPurchaseAmount: -oldPurchase.pricing.totalAmount,
            totalPaidAmount: -oldPurchase.paidAmount
          }
        });
      }
    }

    // 2. Process new items and pricing
    let processedItems = oldPurchase.items;
    let pricing = oldPurchase.pricing;
    if (items) {
      let subtotal = 0;
      processedItems = items.map(item => {
        const qty = Number(item.quantity) || 0;
        const cost = Number(item.costPrice) || 0;
        const lineTotal = qty * cost;
        subtotal += lineTotal;
        return { ...item, total: lineTotal, gstPercent: 0 };
      });
      pricing = { subtotal, gstAmount: 0, totalAmount: subtotal };
    }

    // 3. Update Purchase Record
    const updatedPurchase = await Purchase.findByIdAndUpdate(id, {
      billNumber, supplierName, supplierId, paymentStatus, status, paidAmount, purchaseDate, notes,
      items: processedItems,
      pricing
    }, { new: true });

    // 4. Apply new stock if status is received
    if (updatedPurchase.status === 'received') {
      await syncPurchaseToInventory(updatedPurchase, req.user._id);

      // Apply to Supplier Ledger
      if (updatedPurchase.supplierId) {
        await Supplier.findByIdAndUpdate(updatedPurchase.supplierId, {
          $inc: { 
            totalPurchaseAmount: updatedPurchase.pricing.totalAmount,
            totalPaidAmount: Number(paidAmount) || 0 
          }
        });
      }
    }

    return ApiResponse.success(res, { purchase: updatedPurchase }, 'Purchase updated and inventory synced');
  } catch (error) { next(error); }
};

// ── Helpers for Sync ──────────────────────────────────────────────────────────

async function syncPurchaseToInventory(purchase, userId) {
  const Product = require('../models/Product');
  console.log(`[Sync] Starting inventory sync for ${purchase.purchaseNumber}. Items: ${purchase.items?.length}`);
  for (const item of purchase.items) {
    const productName = item.productName.trim();
    const color = item.color.trim();
    const size = item.size.trim();

    // Find parent product
    const product = await Product.findOne({ name: { $regex: new RegExp('^' + productName + '$', 'i') } });
    
    const filter = { productName, color, size };

    const barcode = item.barcode || `MAG${Date.now().toString().slice(-8)}${Math.floor(Math.random()*100).toString().padStart(2, '0')}`;
    const sku = item.sku || `${productName.slice(0,3)}-${color.slice(0,3)}-${size}`.toUpperCase().replace(/\s+/g, '');
    
    const update = {
      $inc: { totalStock: item.quantity },
      $set: {
        category:      item.category || product?.category || 'Uncategorized',
        purchasePrice: item.costPrice,
        gstPercentage: item.gstPercent || 5,
        productRef:    product?._id || null,
        ...(item.sellingPrice ? { sellingPrice: item.sellingPrice } : (product?.sellingPrice ? { sellingPrice: product.sellingPrice } : {})),
      },
      $addToSet: { images: { $each: item.images?.length > 0 ? item.images : (product?.images?.length > 0 ? [product.images[0]] : []) } },
      $setOnInsert: {
        barcode,
        sku,
        onlineEnabled: true,
        offlineEnabled: true,
        onlineSold: 0, offlineSold: 0, returned: 0, damaged: 0,
        ...(!item.sellingPrice && !product?.sellingPrice ? { sellingPrice: item.costPrice * 1.5 } : {}),
      }
    };

    const inv = await Inventory.findOneAndUpdate(filter, update, { upsert: true, returnDocument: 'after' });
    console.log(`[Sync] Inventory updated: ${inv._id}, New Total: ${inv.totalStock}`);

    await StockMovement.create({
      productId: inv.productRef,
      inventoryId: inv._id,
      variant: { size: item.size, color: item.color },
      type: 'purchase',
      quantity: item.quantity,
      reason: `Purchase Recvd: ${purchase.purchaseNumber}`,
      performedBy: userId,
      referenceId: purchase._id,
      stockBefore: inv.totalStock - item.quantity,
      stockAfter: inv.totalStock
    });
  }
}

async function rollbackPurchaseInventory(purchase, userId) {
  console.log(`[Rollback] Starting inventory rollback for ${purchase.purchaseNumber}. Items: ${purchase.items?.length}`);
  for (const item of purchase.items) {
    const inv = await Inventory.findOne({
      productName: item.productName.trim(),
      color: item.color.trim(),
      size: item.size.trim()
    });

    if (inv) {
      const stockBefore = inv.totalStock;
      inv.totalStock -= item.quantity;
      await inv.save();

      await StockMovement.create({
        inventoryId: inv._id,
        productId: inv.productRef,
        variant: { size: inv.size, color: inv.color },
        type: 'audit_correction',
        quantity: -item.quantity,
        stockBefore,
        stockAfter: inv.totalStock,
        reason: `Purchase Modified/Rollback: ${purchase.purchaseNumber}`,
        performedBy: userId,
        referenceId: purchase._id
      });
    }
  }
}

// ── DELETE /admin/purchases/:id (ERP Rollback) ────────────────────────────────
exports.deletePurchase = async (req, res, next) => {
  try {
    const purchase = await Purchase.findById(req.params.id);
    if (!purchase) return ApiResponse.notFound(res, 'Purchase not found');

    // IF RECEIVED: Must rollback stock and ledger
    if (purchase.status === 'received') {
      // 1. Rollback Supplier Ledger
      if (purchase.supplierId) {
        await Supplier.findByIdAndUpdate(purchase.supplierId, {
          $inc: { 
            totalPurchaseAmount: -purchase.pricing.totalAmount,
            totalPaidAmount: -purchase.paidAmount
          }
        });
      }

      // 2. Rollback Inventory Stock
      for (const item of purchase.items) {
        const inv = await Inventory.findOne({
          productName: item.productName,
          color: item.color,
          size: item.size
        });

        if (inv) {
          // ── PREVENT DELETION IF STOCK IS ALREADY SOLD ──
          const currentAvailable = (inv.totalStock + inv.returned) - (inv.onlineSold + inv.offlineSold + inv.damaged);
          if (currentAvailable < item.quantity) {
            throw new Error(`Cannot delete purchase: ${item.quantity} units of ${item.productName} are required for rollback, but only ${currentAvailable} are available (likely sold).`);
          }

          const stockBefore = inv.totalStock;
          inv.totalStock -= item.quantity;
          await inv.save();

          // 3. Log the reversal
          await StockMovement.create({
            inventoryId: inv._id,
            productId: inv.productRef,
            variant: { size: inv.size, color: inv.color },
            type: 'audit_correction',
            quantity: -item.quantity,
            stockBefore,
            stockAfter: inv.totalStock,
            reason: `Purchase Cancelled/Deleted: ${purchase.purchaseNumber}`,
            performedBy: req.user._id,
            referenceId: purchase._id
          });
        }
      }
    }

    await Purchase.findByIdAndDelete(req.params.id);
    return ApiResponse.success(res, null, 'Purchase deleted and stock rolled back');
  } catch (error) { next(error); }
};

// ── GET /admin/purchases ──────────────────────────────────────────────────────
exports.getPurchases = async (req, res, next) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const query = {};
    const skip  = (page - 1) * Number(limit);

    const [purchases, total] = await Promise.all([
      Purchase.find(query)
        .populate('supplierId', 'name phone')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(Number(limit))
        .lean(),
      Purchase.countDocuments(query),
    ]);

    return ApiResponse.paginated(res, purchases, {
      page: Number(page), limit: Number(limit), total,
      pages: Math.ceil(total / limit),
    });
  } catch (error) { next(error); }
};

// ── GET /admin/suppliers ──────────────────────────────────────────────────
exports.getSuppliers = async (req, res, next) => {
  try {
    const suppliers = await Supplier.aggregate([
      { $match: { isActive: true } },
      {
        $lookup: {
          from: 'purchases',
          localField: '_id',
          foreignField: 'supplierId',
          as: 'purchaseRecords'
        }
      },
      {
        $addFields: {
          procuredVolume: { 
            $add: [
              { $ifNull: ['$openingBalance', 0] },
              { $sum: '$purchaseRecords.pricing.totalAmount' }
            ]
          },
          settledValue: { $sum: '$payments.amount' }
        }
      },
      {
        $addFields: {
          netPayables: { $subtract: ['$procuredVolume', '$settledValue'] },
          // Keep recent purchases for the ledger modal (last 10)
          purchases: { $slice: [{ $reverseArray: '$purchaseRecords' }, 10] }
        }
      },
      { 
        $project: { 
          purchaseRecords: 0,
          // We can also hide these cached fields to avoid confusion, 
          // but we'll keep them for now in case other parts of the system use them.
        } 
      },
      { $sort: { name: 1 } }
    ]);
    
    return ApiResponse.success(res, suppliers);
  } catch (error) { next(error); }
};

// ── PUT /admin/suppliers/:id/record-payment ───────────────────────────────
exports.recordPayment = async (req, res, next) => {
  try {
    const { amount, method, referenceId, note, date } = req.body;
    if (!amount || amount <= 0) return ApiResponse.error(res, 'Valid amount required', 400);

    const supplier = await Supplier.findByIdAndUpdate(
      req.params.id,
      { 
        $push: { payments: { amount, method: method || 'Cash', referenceId, note, date: date || new Date() } },
        $inc: { totalPaidAmount: amount }
      },
      { new: true }
    );

    if (!supplier) return ApiResponse.error(res, 'Supplier not found', 404);
    return ApiResponse.success(res, supplier, 'Payment recorded successfully');
  } catch (error) { next(error); }
};

// ── PUT /admin/suppliers/:supplierId/payments/:paymentId ──────────────────
exports.updatePayment = async (req, res, next) => {
  try {
    const { supplierId, paymentId } = req.params;
    const { amount, method, referenceId, note, date } = req.body;

    const supplier = await Supplier.findById(supplierId);
    if (!supplier) return ApiResponse.notFound(res, 'Supplier not found');

    const payment = supplier.payments.id(paymentId);
    if (!payment) return ApiResponse.notFound(res, 'Payment record not found');

    // 1. Rollback old amount
    supplier.totalPaidAmount -= payment.amount;

    // 2. Update payment fields
    payment.amount = amount || payment.amount;
    payment.method = method || payment.method;
    payment.referenceId = referenceId || payment.referenceId;
    payment.note = note || payment.note;
    payment.date = date || payment.date;

    // 3. Re-apply new amount
    supplier.totalPaidAmount += payment.amount;

    await supplier.save();
    return ApiResponse.success(res, supplier, 'Payment updated successfully');
  } catch (error) { next(error); }
};

// ── DELETE /admin/suppliers/:supplierId/payments/:paymentId ───────────────
exports.deletePayment = async (req, res, next) => {
  try {
    const { supplierId, paymentId } = req.params;
    
    const supplier = await Supplier.findById(supplierId);
    if (!supplier) return ApiResponse.notFound(res, 'Supplier not found');

    const payment = supplier.payments.id(paymentId);
    if (!payment) return ApiResponse.notFound(res, 'Payment record not found');

    // 1. Rollback total paid amount
    supplier.totalPaidAmount -= payment.amount;

    // 2. Remove from array
    supplier.payments.pull(paymentId);

    await supplier.save();
    return ApiResponse.success(res, supplier, 'Payment record removed');
  } catch (error) { next(error); }
};

// ── POST /admin/suppliers ─────────────────────────────────────────────────────
exports.createSupplier = async (req, res, next) => {
  try {
    const supplier = await Supplier.create(req.body);
    return ApiResponse.created(res, supplier, 'Supplier added successfully');
  } catch (error) { next(error); }
};

// ── PUT /admin/suppliers/:id ───────────────────────────────────────────
exports.updateSupplier = async (req, res, next) => {
  try {
    const supplier = await Supplier.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!supplier) return ApiResponse.notFound(res, 'Supplier not found');
    return ApiResponse.success(res, supplier, 'Supplier details updated');
  } catch (error) { next(error); }
};
// ── DELETE /admin/suppliers/:id ──────────────────────────────────────────
exports.deleteSupplier = async (req, res, next) => {
  try {
    const supplierId = req.params.id;

    // 1. Check if supplier has any purchases
    const purchaseCount = await Purchase.countDocuments({ supplierId });
    if (purchaseCount > 0) {
      return ApiResponse.error(res, `Cannot delete supplier: ${purchaseCount} purchase records are linked to this partner. Deactivate them instead.`, 400);
    }

    const supplier = await Supplier.findByIdAndDelete(supplierId);
    if (!supplier) return ApiResponse.notFound(res, 'Supplier not found');

    return ApiResponse.success(res, null, 'Supplier removed successfully');
  } catch (error) { next(error); }
};
