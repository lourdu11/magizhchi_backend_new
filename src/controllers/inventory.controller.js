const Inventory = require('../models/Inventory');
const StockMovement = require('../models/StockMovement');
const ApiResponse = require('../utils/apiResponse');

// ── GET /admin/inventory ───────────────────────────────────────────────────────
exports.getInventory = async (req, res, next) => {
  try {
    const { search, category, onlineEnabled, offlineEnabled, status, productRef, sku, page = 1, limit = 50, includeDeleted = 'false' } = req.query;
    const query = { isDeleted: includeDeleted === 'true' ? true : { $ne: true } };

    if (productRef) query.productRef = productRef;
    if (sku) query.sku = sku;

    if (search) {
      const keywords = search.split(/\s+/).filter(Boolean).map(k => ({
        $or: [
          { productName: { $regex: k, $options: 'i' } },
          { category:    { $regex: k, $options: 'i' } },
          { sku:         { $regex: k, $options: 'i' } },
          { color:       { $regex: k, $options: 'i' } },
        ]
      }));
      if (keywords.length > 0) {
        query.$and = keywords;
      }
    }
    if (category) query.category = { $regex: category, $options: 'i' };
    if (onlineEnabled !== undefined)  query.onlineEnabled  = onlineEnabled  === 'true';
    if (offlineEnabled !== undefined) query.offlineEnabled = offlineEnabled === 'true';
    if (req.query.unlinkedOnly === 'true') query.productRef = null;

    const limitNum = Number(limit);
    const skipNum = (Number(page) - 1) * limitNum;

    // Use aggregation to handle virtual-like calculations in the query
    const pipeline = [
      { $match: query },
      {
        $addFields: {
          availableStock: {
            $max: [
              0,
              { 
                $subtract: [
                  { $add: ["$totalStock", "$returned"] },
                  { $add: ["$onlineSold", "$offlineSold", { $ifNull: ["$reservedStock", 0] }, "$damaged"] }
                ]
              }
            ]
          }
        }
      }
    ];

    if (status) {
      if (status === 'out_of_stock') {
        pipeline.push({ $match: { availableStock: 0 } });
      } else if (status === 'low_stock') {
        pipeline.push({ 
          $match: { 
            $and: [
              { availableStock: { $gt: 0 } },
              { $expr: { $lte: ["$availableStock", { $ifNull: ["$lowStockThreshold", 5] }] } }
            ]
          } 
        });
      } else if (status === 'in_stock') {
        pipeline.push({ 
          $match: { 
            $expr: { $gt: ["$availableStock", { $ifNull: ["$lowStockThreshold", 5] }] } 
          } 
        });
      }
    }

    const [results] = await Inventory.aggregate([
      {
        $facet: {
          data: [
            ...pipeline,
            { $lookup: { from: 'products', localField: 'productRef', foreignField: '_id', as: 'productRef' } },
            { $unwind: { path: '$productRef', preserveNullAndEmptyArrays: true } },
            { $sort: { createdAt: -1 } },
            { $skip: skipNum },
            { $limit: limitNum }
          ],
          total: [
            ...pipeline,
            { $count: "count" }
          ]
        }
      }
    ]);

    const items = results.data;
    const total = results.total[0]?.count || 0;

    return ApiResponse.paginated(res, items, {
      page: Number(page),
      limit: limitNum,
      total,
      pages: Math.ceil(total / limitNum)
    });
  } catch (error) { next(error); }
};

// ── GET /admin/inventory/low-stock ────────────────────────────────────────────
exports.getLowStock = async (req, res, next) => {
  try {
    // BUG #12 FIX: Push filter to MongoDB — never load all records into Node.js memory
    const low = await Inventory.aggregate([
      { $match: { isDeleted: { $ne: true } } },
      {
        $addFields: {
          computedAvail: {
            $max: [0, {
              $subtract: [
                { $add: ['$totalStock', { $ifNull: ['$returned', 0] }] },
                { $add: ['$onlineSold', '$offlineSold', { $ifNull: ['$reservedStock', 0] }, '$damaged'] }
              ]
            }]
          }
        }
      },
      {
        $match: {
          computedAvail: { $gt: 0 },
          $expr: { $lte: ['$computedAvail', { $ifNull: ['$lowStockThreshold', 5] }] }
        }
      },
      { $sort: { computedAvail: 1 } },
      { $limit: 50 }
    ]);
    return ApiResponse.success(res, low);
  } catch (error) { next(error); }
};

// ── GET /admin/inventory/stats ────────────────────────────────────────────────
exports.getInventoryStats = async (req, res, next) => {
  try {
    const all = await Inventory.find({ isDeleted: { $ne: true } }).lean({ virtuals: true });
    
    // Filter only those with physical stock for core metrics
    const activeWithStock = all.filter(i => (i.totalStock || 0) > 0);

    const stats = {
      totalSKUs: activeWithStock.length, // Only count SKUs that actually have items
      totalStockValue: activeWithStock.reduce((sum, i) => sum + (i.totalStock || 0) * (i.purchasePrice || 0), 0),
      onlineOnly:  all.filter(i => i.onlineEnabled && !i.offlineEnabled).length,
      offlineOnly: all.filter(i => !i.onlineEnabled && i.offlineEnabled).length,
      both:        all.filter(i => i.onlineEnabled && i.offlineEnabled).length,
      inactive:    all.filter(i => !i.onlineEnabled && !i.offlineEnabled).length,
      outOfStock:  all.filter(i => {
        const a = Math.max(0, (i.totalStock || 0) - (i.onlineSold || 0) - (i.offlineSold || 0) - (i.reservedStock || 0) + (i.returned || 0) - (i.damaged || 0));
        return a === 0;
      }).length,
      lowStock: all.filter(i => {
        const a = Math.max(0, (i.totalStock || 0) - (i.onlineSold || 0) - (i.offlineSold || 0) - (i.reservedStock || 0) + (i.returned || 0) - (i.damaged || 0));
        return a > 0 && a <= (i.lowStockThreshold || 5);
      }).length,
    };
    return ApiResponse.success(res, stats);
  } catch (error) { next(error); }
};

// ── PUT /admin/inventory/:id/toggle ──────────────────────────────────────────
// Body: { channel: 'online' | 'offline', value: true | false }
exports.toggleChannel = async (req, res, next) => {
  try {
    const { channel } = req.body;
    if (!['online', 'offline'].includes(channel)) {
      return ApiResponse.error(res, 'Channel must be "online" or "offline"', 400);
    }
    const field = channel === 'online' ? 'onlineEnabled' : 'offlineEnabled';

    // Find current value and flip it (toggle)
    const current = await Inventory.findById(req.params.id).select(field);
    if (!current) return ApiResponse.notFound(res, 'Inventory item not found');

    const newValue = !current[field];
    const item = await Inventory.findByIdAndUpdate(
      req.params.id,
      { [field]: newValue },
      { new: true }
    );
    return ApiResponse.success(res, item, `Channel ${channel} ${newValue ? 'enabled' : 'disabled'}`);
  } catch (error) { next(error); }
};

exports.updateChannelConfig = async (req, res, next) => {
  try {
    const { 
      onlineEnabled, onlineAllocatedStock, 
      offlineEnabled, offlineAllocatedStock,
      posDisplayName, posCategory, isDiscountAllowed, maxDiscountPercent
    } = req.body;

    const item = await Inventory.findById(req.params.id);
    if (!item) return ApiResponse.notFound(res, 'Inventory item not found');

    const totalAllocated = (Number(onlineAllocatedStock) || 0) + (Number(offlineAllocatedStock) || 0);
    const available = item.availableStock;

    if (totalAllocated > available) {
      return ApiResponse.error(res, `Total allocation (${totalAllocated}) exceeds available stock (${available})`, 400);
    }

    item.onlineEnabled = onlineEnabled;
    item.onlineAllocatedStock = Number(onlineAllocatedStock) || 0;
    item.offlineEnabled = offlineEnabled;
    item.offlineAllocatedStock = Number(offlineAllocatedStock) || 0;
    item.posDisplayName = posDisplayName || item.posDisplayName;
    item.posCategory = posCategory || item.posCategory;
    item.isDiscountAllowed = isDiscountAllowed !== false;
    item.maxDiscountPercent = Number(maxDiscountPercent) || 100;

    await item.save();
    return ApiResponse.success(res, item, 'Channel configuration updated');
  } catch (error) { next(error); }
};

// ── PUT /admin/inventory/:id/selling-price ───────────────────────────────────
exports.updateSellingPrice = async (req, res, next) => {
  try {
    const { sellingPrice } = req.body;
    if (sellingPrice === undefined || sellingPrice < 0) {
      return ApiResponse.badRequest(res, 'Valid selling price required');
    }
    const item = await Inventory.findByIdAndUpdate(
      req.params.id,
      { sellingPrice: Number(sellingPrice) },
      { new: true }
    );

    if (!item) return ApiResponse.notFound(res, 'Inventory item not found');

    // ── SYNC WITH PRODUCT DISPLAY ──
    if (item.productRef) {
       const SyncService = require('../services/sync.service');
       await SyncService.syncProductStock(item.productRef);
    }

    return ApiResponse.success(res, item, 'Selling price updated and synced with product display');
  } catch (error) { next(error); }
};

// ── GET /admin/inventory/:id/history ──────────────────────────────────────────
exports.getStockHistory = async (req, res, next) => {
  try {
    const history = await StockMovement.find({ inventoryId: req.params.id })
      .populate('performedBy', 'name')
      .sort({ timestamp: -1 })
      .lean();
    return ApiResponse.success(res, history);
  } catch (error) { next(error); }
};

// ── GET /admin/inventory/all-history ──────────────────────────────────────────
exports.getAllStockHistory = async (req, res, next) => {
  try {
    console.log('--- GET ALL STOCK HISTORY HIT ---');
    const { limit = 20 } = req.query;
    const history = await StockMovement.find()
      .populate('performedBy', 'name')
      .populate('productId', 'name')
      .sort({ timestamp: -1 })
      .limit(Number(limit))
      .lean();
    return ApiResponse.success(res, history);
  } catch (error) { next(error); }
};

// ── PUT /admin/inventory/:id/details ─────────────────────────────────────────
exports.updateInventoryDetails = async (req, res, next) => {
  try {
    const { size, color, sku, barcode } = req.body;
    const item = await Inventory.findById(req.params.id);
    if (!item) return ApiResponse.notFound(res, 'Inventory item not found');

    if (size) item.size = size;
    if (color) item.color = color;
    if (sku) item.sku = sku;
    if (barcode) item.barcode = barcode;

    await item.save();

    return ApiResponse.success(res, item, 'Inventory details updated');
  } catch (error) { next(error); }
};

// ── PUT /admin/inventory/:id/adjust ──────────────────────────────────────────
// Body: { type: 'correction_add'|'correction_remove'|'return'|'exchange_in'|'exchange_out'|'damage'|'wastage', quantity, reason }
exports.adjustStock = async (req, res, next) => {
  try {
    const { type, quantity, reason } = req.body;
    const qty = Number(quantity);
    if (!qty || qty < 1) return ApiResponse.badRequest(res, 'Quantity must be >= 1');
    if (!reason)         return ApiResponse.badRequest(res, 'Reason is required');

    const item = await Inventory.findById(req.params.id);
    if (!item) return ApiResponse.notFound(res, 'Inventory item not found');

    const stockBefore = item.availableStock;
    let updateData = {};
    let movementType = 'audit_correction';

    // ── ERP TRANSACTION LOGIC ──
    switch (type) {
      case 'add':
      case 'correction_add':
        updateData = { $inc: { totalStock: qty, availableStock: qty } };
        movementType = 'audit_correction';
        break;
      case 'return':
        updateData = { $inc: { returned: qty, availableStock: qty } }; // Log as returned units
        movementType = 'return_customer';
        break;
      case 'exchange_in':
        updateData = { $inc: { totalStock: qty, availableStock: qty } };
        movementType = 'exchange_in';
        break;
      case 'subtract':
      case 'correction_remove':
        updateData = { $inc: { totalStock: -qty, availableStock: -qty } };
        movementType = 'audit_correction';
        break;
      case 'exchange_out':
        updateData = { $inc: { totalStock: -qty, availableStock: -qty } };
        movementType = 'exchange_out';
        break;
      case 'damage':
      case 'wastage':
        updateData = { $inc: { damaged: qty, availableStock: -qty } }; // Log as damaged units
        movementType = 'damage_wastage';
        break;
      case 'sale_correction':
        updateData = { $inc: { totalStock: -qty, availableStock: -qty } };
        movementType = 'sale_correction';
        break;
      default:
        return ApiResponse.badRequest(res, 'Invalid adjustment logic type');
    }

    const updated = await Inventory.findByIdAndUpdate(req.params.id, updateData, { new: true })
      .lean({ virtuals: true });

    // Stock movement log (ERP Grade)
    await StockMovement.create({
      productId:   item.productRef || null,
      inventoryId: item._id,
      variant:     { size: item.size, color: item.color },
      type:        movementType,
      quantity:    ['add', 'correction_add', 'return', 'exchange_in'].includes(type) ? qty : -qty,
      reason:      reason,
      performedBy: req.user._id,
      stockBefore,
      stockAfter:  updated.availableStock
    });

    // ── TRIGGER STOCK ALERT ──
    const { checkAndAlertLowStock } = require('../utils/lowStockAlert');
    await checkAndAlertLowStock(updated, stockBefore);

    // ── SYNC WITH PRODUCT DOCUMENT ──
    if (item.productRef) {
      const SyncService = require('../services/sync.service');
      await SyncService.syncProductStock(item.productRef);
    }

    return ApiResponse.success(res, updated, 'Inventory reconciled and logged');
  } catch (error) { next(error); }
};

// ... existing code ...
exports.linkProduct = async (req, res, next) => {
// ...
  try {
    const { productId } = req.body;
    const item = await Inventory.findByIdAndUpdate(
      req.params.id,
      { productRef: productId || null },
      { new: true }
    ).lean({ virtuals: true });
    if (!item) return ApiResponse.notFound(res, 'Inventory item not found');
    return ApiResponse.success(res, item, 'Product linked');
  } catch (error) { next(error); }
};

// ── DELETE /admin/inventory/:id ──────────────────────────────────────────────
exports.deleteInventoryItem = async (req, res, next) => {
  try {
    const item = await Inventory.findById(req.params.id);
    if (!item) return ApiResponse.notFound(res, 'Inventory item not found');

    // Check for any historical activity (sales or movements)
    const hasSalesHistory = (item.onlineSold || 0) > 0 || (item.offlineSold || 0) > 0;
    const hasMovements = await StockMovement.exists({ inventoryId: item._id });

    const parentProductRef = item.productRef;

    if (hasSalesHistory || hasMovements) {
      // SOFT DELETE — Archive variant, preserve audit trail
      item.isDeleted = true;
      item.deletedAt = new Date();
      await item.save();

      // Check if parent product has remaining active variants
      if (parentProductRef || item.procurementProductId) {
        const Product = require('../models/Product');
        let parent = parentProductRef ? await Product.findById(parentProductRef) : null;
        if (!parent && item.procurementProductId) {
          parent = await Product.findOne({ procurementSourceId: item.procurementProductId });
        }

        if (parent) {
          const remainingVariants = await Inventory.countDocuments({
            productRef: parent._id,
            isDeleted: { $ne: true }
          });
          if (remainingVariants === 0) {
            // No active variants left — deactivate and archive the product globally
            await Product.findByIdAndUpdate(parent._id, { 
              isActive: false, 
              isDeleted: true,
              deletedAt: new Date(),
              isOnlineProduct: false,
              isBillingProduct: false,
              isInventoryProduct: false
            });
          }
        }
      }

      return ApiResponse.success(res, { archived: true }, 'Variant archived (history preserved for audit)');
    }

    // HARD DELETE — No history, safe to fully remove
    await Inventory.findByIdAndDelete(req.params.id);

    // Check if parent product has remaining active variants
    if (parentProductRef || item.procurementProductId) {
      const Product = require('../models/Product');
      let parent = parentProductRef ? await Product.findById(parentProductRef) : null;
      if (!parent && item.procurementProductId) {
        parent = await Product.findOne({ procurementSourceId: item.procurementProductId });
      }

      if (parent) {
        const remainingVariants = await Inventory.countDocuments({
          productRef: parent._id,
          isDeleted: { $ne: true }
        });
        if (remainingVariants === 0) {
          await Product.findByIdAndUpdate(parent._id, { 
            isActive: false, 
            isDeleted: true,
            deletedAt: new Date(),
            isOnlineProduct: false,
            isBillingProduct: false,
            isInventoryProduct: false
          });
        }
      }
    }

    return ApiResponse.success(res, { archived: false }, 'Variant permanently deleted');
  } catch (error) { next(error); }
};


exports.getByBarcode = async (req, res, next) => {
  try {
    const { barcode } = req.params;
    if (!barcode) return ApiResponse.error(res, 'Barcode is required', 400);

    const item = await Inventory.findOne({ barcode }).populate('productRef').lean();
    if (!item) return ApiResponse.notFound(res, 'Item not found in inventory');

    return ApiResponse.success(res, { 
      item: {
        ...item,
        availableStock: Math.max(0, item.totalStock - item.onlineSold - item.offlineSold - (item.reservedStock || 0) + item.returned - item.damaged)
      }
    });
  } catch (error) { next(error); }
};

// ── POST /admin/inventory ─────────────────────────────────────────────────────
exports.createInventoryItem = async (req, res, next) => {
  try {
    const { productName, color, size, category, sku, sellingPrice, purchasePrice, lowStockThreshold, onlineEnabled, offlineEnabled, productRef } = req.body;
    
    if (!productName || !color || !size) {
      return ApiResponse.badRequest(res, 'Product name, color, and size are required');
    }

    // 1. Check for duplicate
    const exists = await Inventory.findOne({ 
      productName: productName.trim(), 
      color: color.trim(), 
      size: size.trim() 
    });
    
    const stockToInit = Number(req.body.totalStock) || 0;

    // UPSERT LOGIC: If variant already exists, just add stock to it!
    if (exists) {
      if (stockToInit !== 0) {
        exists.totalStock += stockToInit;
        exists.availableStock += stockToInit;
        await exists.save();
        
        // Log movement
        const StockMovement = require('../models/StockMovement');
        await StockMovement.create({
          inventoryId: exists._id,
          type: stockToInit > 0 ? 'purchase' : 'correction_remove',
          quantity: Math.abs(stockToInit),
          reason: 'Manual Stock Update (Quick Entry)',
          performedBy: req.user?._id
        });

        if (exists.productRef) {
          const SyncService = require('../services/sync.service');
          await SyncService.syncProductStock(exists.productRef);
        }
      }
      return ApiResponse.success(res, exists, 'Stock successfully added to existing variant');
    }

    // 2. Auto-link to Product if missing
    let finalProductRef = productRef;
    let parentProduct = null;
    const Product = require('../models/Product');
    
    if (!finalProductRef) {
      parentProduct = await Product.findOne({ name: { $regex: new RegExp('^' + productName.trim() + '$', 'i') } });
      if (parentProduct) finalProductRef = parentProduct._id;
    } else {
      parentProduct = await Product.findById(finalProductRef);
    }

    // 3. Auto-generate SKU and Barcode if missing
    let finalSku = sku;
    if (!finalSku) {
      const words = productName.trim().split(/\s+/).filter(Boolean);
      let initials = 'PRD';
      if (words.length === 1) {
        initials = words[0].slice(0, 3).toUpperCase();
      } else if (words.length >= 2) {
        const firstInit = words[0][0].toUpperCase();
        const secondWord = words[1].toLowerCase();
        let secondInit = words[1][0].toUpperCase();
        if (secondWord.startsWith('sh')) {
          secondInit = 'SH';
        } else if (words.length > 2) {
          secondInit += words[2][0].toUpperCase();
        }
        initials = (firstInit + secondInit).toUpperCase();
      }
      const skuBase = `${initials}-${size.trim()}`.toUpperCase().replace(/\s+/g, '');
      const { getNextSequence } = require('../utils/generateNumbers');
      const seq = await getNextSequence(`SKU-${initials}`);
      finalSku = `${skuBase}-${String(seq).padStart(4, '0')}`;
    } else {
      finalSku = finalSku.trim().toUpperCase().replace(/\s+/g, '');
    }

    const barcode = `MAG${Date.now().toString().slice(-8)}${Math.floor(Math.random()*100).toString().padStart(2, '0')}`;

    // 4. Inherit from Parent Product
    const finalCategory = category || parentProduct?.category || 'Uncategorized';
    const finalSellingPrice = Number(sellingPrice) || parentProduct?.sellingPrice || Number(purchasePrice) * 1.5 || 0;
    const images = (parentProduct?.images?.length > 0) ? [parentProduct.images[0]] : [];

    const stockToInit = Number(req.body.totalStock) || 0;

    const newItem = await Inventory.create({
      productName: productName.trim(),
      color: color.trim(),
      size: size.trim(),
      category: finalCategory,
      sku: finalSku,
      barcode,
      sellingPrice: finalSellingPrice,
      purchasePrice: Number(purchasePrice) || 0,
      lowStockThreshold: Number(lowStockThreshold) || 5,
      onlineEnabled: onlineEnabled !== false,
      offlineEnabled: offlineEnabled !== false,
      productRef: finalProductRef || null,
      images,
      totalStock: stockToInit,
      availableStock: stockToInit
    });

    // Create movement record for manual init
    if (stockToInit > 0) {
      await StockMovement.create({
        inventoryId: newItem._id,
        type: 'purchase',
        quantity: stockToInit,
        reason: 'Manual Inventory Initialization',
        performedBy: req.user?._id
      });
    }

    // 🚀 STOREFRONT SYNC: Propagate the new variant instantly to the Product document
    if (newItem.productRef) {
      const SyncService = require('../services/sync.service');
      await SyncService.syncProductStock(newItem.productRef);
    }

    return ApiResponse.created(res, newItem, 'Variant created successfully with initial stock');
  } catch (error) { next(error); }
};

// ── POST /admin/inventory/restore-channels ────────────────────────────────────
// One-click fix: re-enables Web + POS for ALL in-stock items where either channel is currently OFF.
// Intended as an admin recovery tool, not regular workflow.
exports.restoreAllChannels = async (req, res, next) => {
  try {
    // Find all non-deleted, in-stock items where at least one channel is OFF
    const disabledItems = await Inventory.find({
      isDeleted: { $ne: true },
      availableStock: { $gt: 0 },
      $or: [
        { onlineEnabled: false },
        { offlineEnabled: false }
      ]
    }).select('_id productName size color onlineEnabled offlineEnabled availableStock');

    if (disabledItems.length === 0) {
      return ApiResponse.success(res, { restored: 0, items: [] }, 'All channels already correct — no fixes needed');
    }

    // Enable both channels for all of them atomically
    const ids = disabledItems.map(i => i._id);
    const result = await Inventory.updateMany(
      { _id: { $in: ids } },
      { $set: { onlineEnabled: true, offlineEnabled: true } }
    );

    // ✅ PHASE 2: ORPHANED CLEANUP
    // Find items with 0 totalStock that have NO purchase history (orphaned by bill deletion)
    const StockMovement = require('../models/StockMovement');
    const potentiallyOrphaned = await Inventory.find({
      isDeleted: { $ne: true },
      totalStock: { $lte: 0 }
    }).select('_id');

    let purgedCount = 0;
    if (potentiallyOrphaned.length > 0) {
      for (const item of potentiallyOrphaned) {
        const hasHistory = await StockMovement.findOne({ 
          inventoryId: item._id, 
          type: 'purchase' 
        });
        if (!hasHistory) {
          await Inventory.findByIdAndUpdate(item._id, { $set: { isDeleted: true } });
          purgedCount++;
        }
      }
    }

    return ApiResponse.success(res, {
      restored: result.modifiedCount,
      purged: purgedCount,
      items: disabledItems.map(i => ({
        name: i.productName,
        size: i.size,
        color: i.color,
        stock: i.availableStock,
        was: { web: i.onlineEnabled, pos: i.offlineEnabled }
      }))
    }, `✅ Done: Restored ${result.modifiedCount} variant(s) and purged ${purgedCount} orphaned record(s).`);
  } catch (error) { next(error); }
};

exports.syncAllStock = async (req, res, next) => {
  try {
    const SyncService = require('../services/sync.service');
    const results = await SyncService.runAuditAndRepair();
    return ApiResponse.success(res, results, 'Global stock synchronization complete');
  } catch (error) { next(error); }
};
