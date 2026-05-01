const Inventory = require('../models/Inventory');
const StockMovement = require('../models/StockMovement');
const ApiResponse = require('../utils/apiResponse');

// ── GET /admin/inventory ───────────────────────────────────────────────────────
exports.getInventory = async (req, res, next) => {
  try {
    const { search, category, onlineEnabled, offlineEnabled, status, productRef, sku, page = 1, limit = 50 } = req.query;
    const query = {};

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
    const items = await Inventory.find().lean({ virtuals: true });
    const low = items.filter(i => {
      const avail = Math.max(0, i.totalStock - i.onlineSold - i.offlineSold - (i.reservedStock || 0) + i.returned - i.damaged);
      return avail <= (i.lowStockThreshold || 5);
    });
    return ApiResponse.success(res, low);
  } catch (error) { next(error); }
};

// ── GET /admin/inventory/stats ────────────────────────────────────────────────
exports.getInventoryStats = async (req, res, next) => {
  try {
    const all = await Inventory.find().lean({ virtuals: true });
    const stats = {
      totalSKUs: all.length,
      totalStockValue: all.reduce((sum, i) => sum + i.totalStock * i.purchasePrice, 0),
      onlineOnly:  all.filter(i => i.onlineEnabled && !i.offlineEnabled).length,
      offlineOnly: all.filter(i => !i.onlineEnabled && i.offlineEnabled).length,
      both:        all.filter(i => i.onlineEnabled && i.offlineEnabled).length,
      inactive:    all.filter(i => !i.onlineEnabled && !i.offlineEnabled).length,
      outOfStock:  all.filter(i => {
        const a = Math.max(0, i.totalStock - i.onlineSold - i.offlineSold - (i.reservedStock || 0) + i.returned - i.damaged);
        return a === 0;
      }).length,
      lowStock: all.filter(i => {
        const a = Math.max(0, i.totalStock - i.onlineSold - i.offlineSold - (i.reservedStock || 0) + i.returned - i.damaged);
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
      await require('../models/Product').findByIdAndUpdate(item.productRef, {
        sellingPrice: Number(sellingPrice)
      });
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
        updateData = { $inc: { totalStock: qty } };
        movementType = 'audit_correction';
        break;
      case 'return':
        updateData = { $inc: { returned: qty } }; // Log as returned units
        movementType = 'return_customer';
        break;
      case 'exchange_in':
        updateData = { $inc: { totalStock: qty } };
        movementType = 'exchange_in';
        break;
      case 'subtract':
      case 'correction_remove':
        updateData = { $inc: { totalStock: -qty } };
        movementType = 'audit_correction';
        break;
      case 'exchange_out':
        updateData = { $inc: { totalStock: -qty } };
        movementType = 'exchange_out';
        break;
      case 'damage':
      case 'wastage':
        updateData = { $inc: { damaged: qty } }; // Log as damaged units
        movementType = 'damage_wastage';
        break;
      case 'sale_correction':
        updateData = { $inc: { totalStock: -qty } };
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
    const item = await Inventory.findByIdAndDelete(req.params.id);
    if (!item) return ApiResponse.notFound(res, 'Inventory item not found');
    return ApiResponse.success(res, null, 'Inventory row deleted');
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
    if (exists) return ApiResponse.error(res, 'This variant (Color/Size) already exists for this product', 400);

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
    const finalSku = sku || `${productName.slice(0,3)}-${color.slice(0,3)}-${size}`.toUpperCase().replace(/\s+/g, '');
    const barcode = `MAG${Date.now().toString().slice(-8)}${Math.floor(Math.random()*100).toString().padStart(2, '0')}`;

    // 4. Inherit from Parent Product
    const finalCategory = category || parentProduct?.category || 'Uncategorized';
    const finalSellingPrice = Number(sellingPrice) || parentProduct?.sellingPrice || Number(purchasePrice) * 1.5 || 0;
    const images = (parentProduct?.images?.length > 0) ? [parentProduct.images[0]] : [];

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
      totalStock: 0 // New variants start with 0 stock
    });

    return ApiResponse.created(res, newItem, 'Variant created successfully and synced to catalog');
  } catch (error) { next(error); }
};
