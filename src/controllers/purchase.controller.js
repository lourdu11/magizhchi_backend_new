const mongoose = require('mongoose');
const Purchase = require('../models/Purchase');
const Supplier = require('../models/Supplier');
const Inventory = require('../models/Inventory');
const StockMovement = require('../models/StockMovement');
const ApiResponse = require('../utils/apiResponse');
const logger = require('../utils/logger');
const SyncService = require('../services/sync.service');
const stockService = require('../services/stockService');
const { clearDashboardCache } = require('./admin.controller');
const { logAudit } = require('../utils/auditLogger');

// ── POST /admin/purchases ─────────────────────────────────────────────────────
exports.createPurchase = async (req, res, next) => {
  try {
    const { supplierId, supplierName, billNumber, items, pricing, paymentStatus, status, paidAmount, purchaseDate, notes, billImage } = req.body;

    if (!items || items.length === 0) {
      return ApiResponse.error(res, 'At least one item is required', 400);
    }

    // 1. Generate Purchase Number (ERP Sequential ID)
    const year = new Date().getFullYear();
    const { getNextSequence } = require('../utils/generateNumbers');
    const sequence = await getNextSequence(`PUR-${year}`);
    const purchaseNumber = `PUR-${year}-${String(sequence).padStart(4, '0')}`;

    // 2. Auto-calculate pricing and resolve product references
    const Product = require('../models/Product');
    let subtotal = 0;
    let totalGst = 0;
    const processedItems = [];
    
    for (const item of items) {
      if (!item.productName || !item.size || Number(item.quantity) <= 0) continue;

      const qty   = Number(item.quantity) || 0;
      const cost  = Number(item.costPrice) || 0;
      const lineTotal = qty * cost;
      
      const gstRate = (item.gstPercent || 5) / 100;
      const itemGst = lineTotal * gstRate;
      
      subtotal += lineTotal;
      totalGst += itemGst;

      let productId = item.productId || null;
      if (!productId) {
        // Robust exact match with regex escaping
        const escapedName = item.productName.trim().replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
        const product = await Product.findOne({ name: { $regex: new RegExp('^' + escapedName + '$', 'i') } });
        productId = product ? product._id : null;
      }

      processedItems.push({ 
        ...item, 
        productId,
        total: lineTotal, 
        gstAmount: parseFloat(itemGst.toFixed(2)),
        gstPercent: item.gstPercent || 5 
      });
    }

    if (processedItems.length === 0) {
      return ApiResponse.error(res, 'At least one valid item is required', 400);
    }
    const gstAmount = parseFloat(totalGst.toFixed(2));
    const totalAmount = parseFloat((subtotal + gstAmount).toFixed(2));

    // 3. Save purchase bill
    const purchase = await Purchase.create({
      purchaseNumber,
      billNumber:   billNumber || '',
      supplierName: supplierName || '',
      supplierId:   supplierId || null,
      items:        processedItems,
      pricing:      { 
        subtotal, 
        gstAmount, 
        totalAmount,
        manualFinancialImpact: req.body.pricing?.manualFinancialImpact ?? null 
      },
      status:       status || 'received',
      paidAmount:   Number(paidAmount) || 0,
      paymentStatus: paymentStatus || 'pending',
      purchaseDate:  purchaseDate || new Date(),
      notes,
      billImage,
      performedBy: req.user._id,
    });

    // 4. Update Inventory & Supplier ONLY if received
    if (purchase.status === 'received') {
      // A. Update Supplier Ledger
      if (supplierId) {
        const impactAmount = purchase.pricing.manualFinancialImpact !== null ? purchase.pricing.manualFinancialImpact : totalAmount;
        const supplierUpdate = {
          $inc: { 
            totalPurchaseAmount: impactAmount,
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

      // B. Update Inventory & Catalog Master via Enterprise Sync Service
      try {
        await SyncService.syncPurchaseToCatalog(purchase._id, req.user._id);
      } catch (syncErr) {
        // Revert purchase to draft so admin can re-try — prevents ghost purchase with no stock
        await Purchase.findByIdAndUpdate(purchase._id, {
          status: 'draft',
          notes: `[SYNC ERROR: ${syncErr.message}] ${notes || ''}`
        });
        // Rollback supplier ledger update
        if (supplierId) {
          await Supplier.findByIdAndUpdate(supplierId, {
            $inc: { totalPurchaseAmount: -totalAmount, totalPaidAmount: -(Number(paidAmount) || 0) }
          });
        }
        return ApiResponse.error(res, `Purchase saved but inventory sync failed: ${syncErr.message}. Purchase set to draft — please re-submit.`, 500);
      }
    }

    clearDashboardCache();

    return ApiResponse.created(res, { purchase }, 'Purchase recorded successfully');
  } catch (error) { next(error); }
};

// ── POST /admin/purchases/:id/resync (Repair Sync) ──────────────────────────
exports.resyncPurchase = async (req, res, next) => {
  try {
    const purchase = await Purchase.findById(req.params.id);
    if (!purchase) return ApiResponse.notFound(res, 'Bill not found');
    if (purchase.isDeleted) return ApiResponse.badRequest(res, 'Cannot re-sync an archived bill. Restore it first.');

    // Force full sync to repair any missing catalog/inventory records
    await SyncService.syncPurchaseToCatalog(purchase._id, req.user._id);

    return ApiResponse.success(res, null, 'Catalog & Inventory repaired successfully');
  } catch (error) { next(error); }
};

// ── PUT /admin/purchases/:id ──────────────────────────────────────────────────
exports.updatePurchase = async (req, res, next) => {
  const { id } = req.params;
    const oldPurchase = await Purchase.findById(id);
    if (!oldPurchase) return ApiResponse.notFound(res, 'Purchase not found');

    const { supplierId, supplierName, billNumber, paymentStatus, status, paidAmount, purchaseDate, notes, items, billImage } = req.body;

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      // 1. Rollback old stock if it was already received
      if (oldPurchase.status === 'received') {
        await SyncService.rollbackStockForUpdate(id, req.user._id, session);
        
        // Rollback Supplier Ledger
        if (oldPurchase.supplierId) {
          await Supplier.findByIdAndUpdate(oldPurchase.supplierId, {
            $inc: { 
              totalPurchaseAmount: -oldPurchase.pricing.totalAmount,
              totalPaidAmount: -oldPurchase.paidAmount
            }
          }).session(session);
        }
      }

    // 2. Process items and strictly calculate pricing (Source of Truth)
    let processedItems = oldPurchase.items;
    let pricing = oldPurchase.pricing;
    if (items && Array.isArray(items)) {
      const Product = require('../models/Product');
      let subtotal = 0;
      let totalGst = 0;
      const validItems = [];
      
      for (const item of items) {
        // Only keep items with valid name, size and quantity
        if (!item.productName || !item.size || Number(item.quantity) <= 0) continue;

        const qty = Number(item.quantity) || 0;
        const cost = Number(item.costPrice) || 0;
        const lineTotal = qty * cost;
        
        const gstRate = (item.gstPercent || 5) / 100;
        const itemGst = lineTotal * gstRate;
        
        subtotal += lineTotal;
        totalGst += itemGst;

        // Auto-resolve productId
        let productId = item.productId || null;
        if (!productId) {
          const product = await Product.findOne({ name: { $regex: new RegExp('^' + item.productName.trim() + '$', 'i') } });
          productId = product ? product._id : null;
        }

        validItems.push({ 
          ...item, 
          productId,
          total: lineTotal, 
          gstPercent: item.gstPercent || 5 
        });
      }
      
      if (validItems.length === 0) {
        return ApiResponse.error(res, 'Cannot update to an empty bill. Add at least one valid item.', 400);
      }

      processedItems = validItems;
      
      const gstAmount = parseFloat(totalGst.toFixed(2));
      pricing = { 
        subtotal, 
        gstAmount, 
        totalAmount: parseFloat((subtotal + gstAmount).toFixed(2)),
        manualFinancialImpact: req.body.pricing?.manualFinancialImpact ?? oldPurchase.pricing.manualFinancialImpact 
      };
    } else if (items && items.length === 0) {
       return ApiResponse.error(res, 'Purchase bill cannot be empty', 400);
    } else {
      // If items not provided but manual impact is
      if (req.body.pricing?.manualFinancialImpact !== undefined) {
        pricing = {
          ...oldPurchase.pricing,
          manualFinancialImpact: req.body.pricing.manualFinancialImpact
        };
      }
    }

    // 3. Update Purchase Record
    const updatedPurchase = await Purchase.findByIdAndUpdate(id, {
      billNumber, supplierName, supplierId, paymentStatus, status, paidAmount, purchaseDate, notes,
      items: processedItems,
      pricing,
      billImage
    }, { new: true, session });

    if (!updatedPurchase) throw new Error('Failed to update purchase record');

    // 4. Apply new stock if status is received
    if (updatedPurchase.status === 'received') {
      // Note: SyncService methods handle their own transaction internals or can accept a session
      // For consistency, we should ensure the Catalog Sync also uses the same session
      await SyncService.syncPurchaseToCatalog(updatedPurchase._id, req.user._id, session);

      // Apply to Supplier Ledger
      if (updatedPurchase.supplierId) {
        const impactAmount = updatedPurchase.pricing.manualFinancialImpact !== null ? updatedPurchase.pricing.manualFinancialImpact : updatedPurchase.pricing.totalAmount;
        await Supplier.findByIdAndUpdate(updatedPurchase.supplierId, {
          $inc: { 
            totalPurchaseAmount: impactAmount,
            totalPaidAmount: Number(paidAmount) || 0 
          }
        }).session(session);
      }
    }

    await session.commitTransaction();
    clearDashboardCache();
    return ApiResponse.success(res, { purchase: updatedPurchase }, 'Purchase updated and synchronized successfully');
  } catch (error) { 
    if (session) await session.abortTransaction();
    next(error); 
  } finally {
    if (session) session.endSession();
  }
};

// ── Helpers for Sync ──────────────────────────────────────────────────────────

exports.syncPurchaseToInventory = async function (purchase, userId) {
  const Product = require('../models/Product');
  const Category = require('../models/Category');
  const logger = require('../utils/logger');
  
  logger.info(`[Sync] Starting inventory sync for ${purchase.purchaseNumber}. Items: ${purchase.items?.length}`);
  
  for (const item of purchase.items) {
    const productName = (item.productName || '').trim();
    const color = (item.color || '').trim();
    const size = (item.size || '').trim();

    // 1. Find or AUTO-CREATE parent product (Centralized Master Source logic)
    let product = await Product.findOne({ name: { $regex: new RegExp('^' + productName + '$', 'i') } });
    
    if (!product) {
      // 🚀 AUTO-CREATE MASTER PRODUCT: Ensure it appears in Gallery immediately
      logger.info(`[Sync] Creating master product profile for: ${productName}`);
      
      // Resolve category ID (Centralized Category Management)
      let categoryId = null;
      const catName = (item.category || 'Uncategorized').trim();
      const cat = await Category.findOne({ name: { $regex: new RegExp('^' + catName + '$', 'i') } });
      
      if (cat) {
        categoryId = cat._id;
      } else {
        // Create the 'Uncategorized' or missing category on the fly
        const newCat = await Category.create({ 
          name: catName,
          slug: catName.toLowerCase().replace(/[^a-z0-9]+/g, '-')
        });
        categoryId = newCat._id;
      }

      // Generate a unique SKU if not provided
      const productSku = item.sku || `PRD-${productName.slice(0,3).toUpperCase()}-${Date.now().toString().slice(-4)}`;

      product = await Product.create({
         name: productName,
         slug: productName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') + '-' + Date.now().toString().slice(-4),
         sku: productSku,
         category: categoryId,
         description: `Sourced via Procurement Bill ${purchase.billNumber}`,
         sellingPrice: Number(item.sellingPrice) || Number(item.costPrice) * 1.5 || 0,
         images: item.images?.length > 0 ? [item.images[0]] : [],
         isActive: true,
         source: 'procurement',
         procurementSourceId: item.sku || productSku
      });
    }
    
    const targetProductName = product.name;

    // 2. NEW SYNC: Update Product.variants (Single Table Source of Truth)
    const variantBarcode = item.barcode || `MAG${Date.now().toString().slice(-8)}${Math.floor(Math.random()*100).toString().padStart(2, '0')}`;
    const variantSku = item.sku || `${targetProductName.slice(0,3)}-${color.slice(0,3)}-${size}`.toUpperCase().replace(/\s+/g, '');
    
    // Check if variant exists in product
    let variantIndex = product.variants.findIndex(v => 
       v.size.toLowerCase() === size.toLowerCase() && 
       (v.color || '').toLowerCase() === color.toLowerCase()
    );

    if (variantIndex > -1) {
       // Update existing variant (Identity & Price only, stock is in Inventory)
       if (item.sellingPrice) product.variants[variantIndex].price = item.sellingPrice;
       product.variants[variantIndex].isDeleted = false;
       
       // SMART RESTORE: Enable if being restocked
       product.variants[variantIndex].onlineEnabled = true;
       product.variants[variantIndex].offlineEnabled = true;
    } else {
       // Add new variant
       product.variants.push({
          size,
          color,
          sku: variantSku,
          barcode: variantBarcode,
          price: item.sellingPrice || product.sellingPrice,
          onlineEnabled: true,
          offlineEnabled: true
       });
    }

    // Update global product fields from bill
    if (item.category) {
       const Category = require('../models/Category');
       const cat = await Category.findOne({ name: { $regex: new RegExp('^' + item.category.trim() + '$', 'i') } });
       if (cat) product.category = cat._id;
    }
    
    product.costPrice = item.costPrice;
    product.isProcurementProduct = true;
    product.source = 'procurement';
    if (!product.procurementSourceId) product.procurementSourceId = item.sku || variantSku;
    if (item.sellingPrice) product.sellingPrice = item.sellingPrice;

     // Save the Product Profile
     await product.save();
     
     // Sync stock summary from Inventory (definitive source)
     await stockService.syncProductStockSummary(product._id);
     console.log(`[Sync] Product Profile updated: ${product.name}`);

    // 3. LEGACY SYNC: Keep Inventory model in sync during transition
    const Inventory = require('../models/Inventory');
    const existingInv = await Inventory.findOne({
      productName: { $regex: new RegExp('^' + targetProductName + '$', 'i') },
      color: { $regex: new RegExp('^' + color + '$', 'i') },
      size: { $regex: new RegExp('^' + size + '$', 'i') }
    });

    const filter = existingInv ? { _id: existingInv._id } : {
      productName: targetProductName,
      color: color,
      size: size
    };

    const update = {
      $inc: { totalStock: item.quantity, availableStock: item.quantity },
      $set: {
        category:      item.category || product?.category || 'Uncategorized',
        purchasePrice: item.costPrice,
        gstPercentage: item.gstPercent || 5,
        productRef:    product?._id || null,
        procurementProductId: item.sku || variantSku,
        isDeleted:     false,
        ...(item.sellingPrice ? { sellingPrice: item.sellingPrice } : (product?.sellingPrice ? { sellingPrice: product.sellingPrice } : {})),
      },
      $addToSet: { images: { $each: item.images?.length > 0 ? item.images : (product?.images?.length > 0 ? [product.images[0]] : []) } },
      $setOnInsert: {
        barcode: variantBarcode,
        sku: variantSku,
        onlineEnabled: true,
        offlineEnabled: true,
        onlineSold: 0, offlineSold: 0, returned: 0, damaged: 0,
        ...(!item.sellingPrice && !product?.sellingPrice ? { sellingPrice: item.costPrice * 1.5 } : {}),
      }
    };

    const inv = await Inventory.findOneAndUpdate(filter, update, { upsert: true, returnDocument: 'after' });
    console.log(`[Sync] Legacy Inventory updated: ${inv._id}`);

    // ✅ SMART CHANNEL RESTORE: If the item existed and was at 0 stock before this purchase,
    // re-enable both channels so it surfaces on Web & POS again.
    if (existingInv) {
      const prevAvailable = Math.max(
        0,
        (existingInv.totalStock || 0) +
        (existingInv.returned || 0) -
        (existingInv.onlineSold || 0) -
        (existingInv.offlineSold || 0) -
        (existingInv.damaged || 0) -
        (existingInv.reservedStock || 0)
      );
      if (prevAvailable === 0) {
        // Item was out of stock → restocking should re-list it on all channels
        await Inventory.findByIdAndUpdate(inv._id, {
          $set: { onlineEnabled: true, offlineEnabled: true }
        });
         console.log(`[Sync] Channels restored for ${inv.productName} (${inv.size}/${inv.color}) — was out of stock`);
      }
    }

    // FINAL CASCADE: Sync product again after inventory update
    await stockService.syncProductStockSummary(product._id);
    clearDashboardCache();

    await StockMovement.create({
      productId: inv.productRef,
      inventoryId: inv._id,
      variant: { size: inv.size, color: inv.color },
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

// Legacy helper removed — Replaced by SyncService.rollbackStockForUpdate

// ── DELETE /admin/purchases/:id (ERP Rollback + Soft Delete) ───────────────────
exports.deletePurchase = async (req, res, next) => {
  try {
    const purchase = await Purchase.findById(req.params.id);
    if (!purchase) return ApiResponse.notFound(res, 'Purchase not found');

    if (purchase.isDeleted) {
      return ApiResponse.error(res, 'This purchase is already deleted/archived', 400);
    }

    // ENTERPRISE SYNC: Rollback stock, archive variants/products, and mark purchase as deleted atomically
    await SyncService.rollbackPurchase(req.params.id, req.user._id);
    clearDashboardCache();

    return ApiResponse.success(res, null, 'Purchase archived and stock rolled back across catalog');
  } catch (error) { next(error); }
};

// ── POST /admin/purchases/:id/restore (Restore from Archive) ───────────────────
exports.restorePurchase = async (req, res, next) => {
  try {
    const purchase = await Purchase.findById(req.params.id);
    if (!purchase) return ApiResponse.notFound(res, 'Purchase not found');

    if (!purchase.isDeleted) {
      return ApiResponse.error(res, 'This purchase is already active', 400);
    }

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      // 1. Un-archive Purchase
      purchase.isDeleted = false;
      purchase.status = 'received';
      purchase.deletedAt = undefined;
      purchase.deletedBy = undefined;
      await purchase.save({ session });

      // 2. Re-apply to Supplier Ledger
      if (purchase.supplierId && purchase.status === 'received') {
        const impactAmount = purchase.pricing.manualFinancialImpact !== null ? purchase.pricing.manualFinancialImpact : purchase.pricing.totalAmount;
        await Supplier.findByIdAndUpdate(purchase.supplierId, {
          $inc: { 
            totalPurchaseAmount: impactAmount,
            totalPaidAmount: purchase.paidAmount || 0 
          }
        }).session(session);
      }

      // 3. Re-sync to Catalog & Inventory
      await SyncService.syncPurchaseToCatalog(purchase._id, req.user._id, session);

      await session.commitTransaction();
      clearDashboardCache();
      return ApiResponse.success(res, { purchase }, 'Purchase restored and stock synchronized successfully');
    } catch (err) {
      await session.abortTransaction();
      throw err;
    } finally {
      session.endSession();
    }
  } catch (error) { next(error); }
};

// ── GET /admin/purchases ──────────────────────────────────────────────────────
exports.getPurchases = async (req, res, next) => {
  try {
    const pageNum  = Math.max(1, parseInt(req.query.page, 10)  || 1);
    const limitNum = Math.max(1, parseInt(req.query.limit, 10) || 20);
    const { search } = req.query;
    const skip = (pageNum - 1) * limitNum;

    // 1. Build Base Match Filter
    const showDeleted = req.query.showDeleted === 'true';
    const filter = { isDeleted: showDeleted ? true : { $in: [false, null, undefined] } };
    if (search) {
      filter.$or = [
        { billNumber: { $regex: search, $options: 'i' } },
        { purchaseNumber: { $regex: search, $options: 'i' } },
        { supplierName: { $regex: search, $options: 'i' } }
      ];
    }

    // 2. Optimized Pipeline
    const pipeline = [
      { $match: filter },
      { $sort: { createdAt: -1 } },
      { $skip: skip },
      { $limit: limitNum },

      // ── Relational Integrity Join ──
      // Lookup Supplier
      {
        $lookup: {
          from: 'suppliers',
          localField: 'supplierId',
          foreignField: '_id',
          as: 'supplierInfo'
        }
      },
      { $addFields: { supplierId: { $arrayElemAt: ['$supplierInfo', 0] } } },

      // Lookup Products for verification (Optional but good for UI flags)
      { $unwind: { path: '$items', preserveNullAndEmptyArrays: true } },
      {
        $lookup: {
          from: 'products',
          localField: 'items.productId',
          foreignField: '_id',
          as: 'productInfo'
        }
      },
      { $addFields: { 
          'items.isValidProduct': { 
            $cond: {
              if: { $gt: [{ $size: '$productInfo' }, 0] },
              then: { $arrayElemAt: ['$productInfo.isActive', 0] },
              else: false
            }
          } 
      }},
      
      // Regroup items
      { $group: {
          _id: '$_id',
          doc: { $first: '$$ROOT' },
          items: { $push: '$items' }
      }},
      { $replaceRoot: { newRoot: { $mergeObjects: ['$doc', { items: '$items' }] } } },
      { $project: { supplierInfo: 0, productInfo: 0 } },
      { $sort: { createdAt: -1 } } // Re-sort after grouping if needed
    ];

    const [total, purchases] = await Promise.all([
      Purchase.countDocuments(filter),
      Purchase.aggregate(pipeline)
    ]);

    return ApiResponse.paginated(res, purchases, {
      page: pageNum,
      limit: limitNum,
      total,
      pages: Math.ceil(total / limitNum),
    });
  } catch (error) {
    logger.error(`[getPurchases] Error: ${error.message}\nStack: ${error.stack}`);
    next(error);
  }
};

// ── GET /admin/suppliers ──────────────────────────────────────────────────
exports.getSuppliers = async (req, res, next) => {
  try {
    const showDeleted = req.query.showDeleted === 'true';
    const pipeline = [
      { $match: { isDeleted: showDeleted ? true : { $in: [false, null, undefined] }, isActive: !showDeleted } },
      
      // 1. Lookup VALID purchases (only those with active items)
      {
        $lookup: {
          from: 'purchases',
          let: { supplier_id: '$_id' },
          pipeline: [
            { $match: { $expr: { $and: [ { $eq: ['$supplierId', '$$supplier_id'] }, { $ne: ['$isDeleted', true] } ] } } },
            { $unwind: '$items' },
            // Regroup items back into their bills — NO FILTERING based on product status here!
            // Ledger must be consistent even if products are deactivated later.
            { $group: {
                _id: '$_id',
                manualFinancialImpact: { $first: '$pricing.manualFinancialImpact' },
                totalAmount: { $first: '$pricing.totalAmount' },
                purchaseNumber: { $first: '$purchaseNumber' },
                items: { $push: '$items' }
            }}
          ],
          as: 'purchaseRecords'
        }
      },
      {
        $addFields: {
          procuredVolume: { 
            $sum: {
                $map: {
                  input: '$purchaseRecords',
                  as: 'p',
                  in: { $ifNull: ['$$p.manualFinancialImpact', '$$p.totalAmount'] }
                }
            }
          },
          settledValue: { $sum: '$payments.amount' }
        }
      },
      {
        $addFields: {
          netPayables: { 
            $subtract: [
              { $add: [{ $ifNull: ['$procuredVolume', 0] }, { $ifNull: ['$openingBalance', 0] }] }, 
              '$settledValue' 
            ] 
          },
          // Keep recent purchases for the ledger modal (last 10)
          purchases: { $slice: [{ $reverseArray: '$purchaseRecords' }, 10] }
        }
      },
      { 
        $project: { 
          purchaseRecords: 0
        } 
      },
      { $sort: { name: 1 } }
    ];
    
    const suppliers = await Supplier.aggregate(pipeline);
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
    const data = { ...req.body };
    data.openingBalance = Number(data.openingBalance) || 0;

    if (data.name) {
      const trimmedName = data.name.trim();
      const trimmedPhone = data.phone ? data.phone.trim() : '';

      let existingSupplier = null;
      if (trimmedName) {
        existingSupplier = await Supplier.findOne({
          name: { $regex: new RegExp("^" + trimmedName.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&') + "$", "i") }
        });
      }

      if (!existingSupplier && trimmedPhone) {
        existingSupplier = await Supplier.findOne({ phone: trimmedPhone });
      }

      if (existingSupplier) {
        existingSupplier.openingBalance += Number(data.openingBalance) || 0;
        if (!existingSupplier.phone && data.phone) existingSupplier.phone = data.phone;
        if (!existingSupplier.email && data.email) existingSupplier.email = data.email;
        if (!existingSupplier.gstin && data.gstin) existingSupplier.gstin = data.gstin;
        if (!existingSupplier.address && data.address) existingSupplier.address = data.address;

        await existingSupplier.save();
        return ApiResponse.success(res, existingSupplier, 'Supplier already exists, balance and details merged successfully');
      }
    }

    const supplier = await Supplier.create(data);
    return ApiResponse.created(res, supplier, 'Supplier added successfully');
  } catch (error) { next(error); }
};

// ── PUT /admin/suppliers/:id ───────────────────────────────────────────
exports.updateSupplier = async (req, res, next) => {
  try {
    const data = { ...req.body };
    data.openingBalance = Number(data.openingBalance) || 0;
    const supplier = await Supplier.findByIdAndUpdate(req.params.id, data, { new: true });
    if (!supplier) return ApiResponse.notFound(res, 'Supplier not found');
    return ApiResponse.success(res, supplier, 'Supplier details updated');
  } catch (error) { next(error); }
};
// ── DELETE /admin/suppliers/:id (Archival Soft Delete) ───────────────────────
exports.deleteSupplier = async (req, res, next) => {
  try {
    const supplierId = req.params.id;

    // 1. Check if supplier has any purchases
    // BUG #13 FIX: Exclude soft-deleted purchases from the check
    const purchaseCount = await Purchase.countDocuments({ supplierId, isDeleted: { $ne: true } });
    
    if (purchaseCount > 0) {
      // ── ARCHIVE (Soft Delete) ──────────────────────────────────────────────
      // If history exists, we MUST archive them to preserve ledger/audit integrity
      const supplier = await Supplier.findByIdAndUpdate(supplierId, { 
        isActive: false, 
        isDeleted: true,
        deletedAt: new Date()
      }, { new: true });
      
      if (!supplier) return ApiResponse.notFound(res, 'Supplier not found');
      return ApiResponse.success(res, null, 'Supplier archived (procurement records preserved for audit)');
    }

    // ── HARD DELETE ──────────────────────────────────────────────────────────
    // If brand new with absolutely no history, we can wipe completely
    const supplier = await Supplier.findByIdAndDelete(supplierId);
    if (!supplier) return ApiResponse.notFound(res, 'Supplier not found');

    return ApiResponse.success(res, null, 'Supplier removed permanently');
  } catch (error) { next(error); }
};

// ── POST /admin/suppliers/:id/restore (Restore Partner) ──────────────────────
exports.restoreSupplier = async (req, res, next) => {
  try {
    const supplier = await Supplier.findByIdAndUpdate(req.params.id, {
      isActive: true,
      isDeleted: false,
      deletedAt: null
    }, { new: true });

    if (!supplier) return ApiResponse.notFound(res, 'Supplier not found');
    return ApiResponse.success(res, supplier, 'Trade Partner restored successfully');
  } catch (error) { next(error); }
};
