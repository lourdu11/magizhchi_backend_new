const Product = require('../models/Product');
const Category = require('../models/Category');
const StockMovement = require('../models/StockMovement');
const ApiResponse = require('../utils/apiResponse');
const stockService = require('../services/stockService');
const slugify = require('slugify');
const { generateSKU, generatePurchaseNumber } = require('../utils/generateNumbers');
const { deleteFile } = require('../utils/fileHelper');
const Purchase = require('../models/Purchase');
const mongoose = require('mongoose');

const logger = require('../utils/logger');
const SyncService = require('../services/sync.service');
const Inventory = require('../models/Inventory');
const { startTransactionSession } = require('../utils/transaction');

// GET /products (Public/POS)
exports.getProducts = async (req, res, next) => {
  try {
    const { lastId, limit = 20, category, search, minPrice, maxPrice, size, sort = '-createdAt', isFeatured, isBestSeller, isNewArrival, isPOS, isAdmin, showDeleted } = req.query;

    const query = { isActive: { $ne: false }, isDeleted: { $ne: true }, isArchived: { $ne: true } };

    if (showDeleted === 'true') {
       delete query.isDeleted;
       query.isDeleted = true;
    }

    if (isAdmin === 'true') {
       delete query.isActive; 
       res.set('Cache-Control', 'no-store');
    } else if (isPOS === 'true') {
       delete query.isActive;
       query.isBillingProduct = true;
       res.set('Cache-Control', 'no-store');
    } else {
       query.isOnlineProduct = true;
       query.isActive = true;
       res.set('Cache-Control', 'public, max-age=60, s-maxage=60, stale-while-revalidate=300');
    }

    if (category) {
       if (mongoose.Types.ObjectId.isValid(category)) {
          query.category = category;
       } else {
          const cat = await Category.findOne({
             $or: [
                { slug: category.toLowerCase() },
                { name: { $regex: new RegExp(`^${category}$`, 'i') } }
             ]
          });
          if (cat) query.category = cat._id;
          else query.category = new mongoose.Types.ObjectId(); // Return empty if not found
       }
    }

    if (search) {
       query.$or = [
          { name: { $regex: search, $options: 'i' } },
          { sku: { $regex: search, $options: 'i' } },
          { barcode: { $regex: search, $options: 'i' } },
          { 'variants.barcode': { $regex: search, $options: 'i' } },
          { description: { $regex: search, $options: 'i' } }
       ];
    }

    if (minPrice || maxPrice) {
       query.sellingPrice = {};
       if (minPrice) query.sellingPrice.$gte = Number(minPrice);
       if (maxPrice) query.sellingPrice.$lte = Number(maxPrice);
    }

    if (isFeatured === 'true') query.isFeatured = true;
    if (isBestSeller === 'true') query.isBestSeller = true;
    if (isNewArrival === 'true') query.isNewArrival = true;

    if (size) {
       const sizeArray = size.split(',').filter(Boolean);
       if (sizeArray.length > 0) query['variants.size'] = { $in: sizeArray };
    }

    if (lastId) {
       query._id = { $lt: lastId };
    }

    const products = await Product.find(query)
       .populate('category', 'name slug')
       .sort({ createdAt: -1, _id: -1 })
       .limit(Number(limit) + 1)
       .lean();

    const hasMore = products.length > Number(limit);
    const data = hasMore ? products.slice(0, -1) : products;
    const nextCursor = hasMore ? data[data.length - 1]._id : null;

    // 🚀 ULTRA PERFORMANCE: Batch-fetch ALL inventory for this page in ONE query
    // instead of per-product SyncService calls (eliminates N+1 query problem)
    const productIds = data.map(p => p._id);
    const inventoryRecords = await Inventory.find({
      productRef: { $in: productIds },
      isDeleted: { $ne: true }
    }).lean();

    // Build a quick lookup map: productId -> [inventoryItems]
    const inventoryMap = inventoryRecords.reduce((acc, inv) => {
      const key = String(inv.productRef);
      if (!acc[key]) acc[key] = [];
      acc[key].push(inv);
      return acc;
    }, {});

    const processedData = data.map(p => {
      const invItems = inventoryMap[String(p._id)] || [];
      // Calculate available stock from inventory records (same formula as SyncService)
      let availableStock = 0;
      const variants = invItems.map(inv => {
        const avail = Math.max(0, (inv.totalStock + (inv.returned || 0)) -
          (inv.onlineSold + inv.offlineSold + (inv.reservedStock || 0) + (inv.damaged || 0)));
        availableStock += avail;
        return { ...inv, availableStock: avail, size: inv.size, color: inv.color, sku: inv.sku, sellingPrice: inv.sellingPrice };
      });
      // Fallback to product-level stock if no inventory linked
      const finalStock = invItems.length > 0 ? availableStock : (p.availableStock || 0);
      return {
        ...p,
        variants: variants.length > 0 ? variants : (p.variants || []),
        availableStock: finalStock,
        syncedVariants: variants
      };
    });

    return ApiResponse.success(res, {
       data: processedData,
       nextCursor,
       hasMore
    });

  } catch (error) { next(error); }
};

// GET /products/admin (Admin Profile Center)
exports.getAdminProducts = async (req, res, next) => {
  try {
    const { lastId, category, search, sort = 'newest', limit = 100, showDeleted, showArchived } = req.query;
    const query = { isDeleted: { $ne: true } };

    const filterArchived = showDeleted === 'true' || showArchived === 'true';
    if (filterArchived) {
      query.isArchived = true;
    } else {
      query.isArchived = { $ne: true };
    }

    if (category) query.category = category;
    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { sku: { $regex: search, $options: 'i' } }
      ];
    }

    if (lastId) {
      query._id = { $lt: lastId };
    }

    const products = await Product.find(query)
      .populate('category', 'name slug')
      .sort({ createdAt: -1, _id: -1 })
      .limit(Number(limit) + 1)
      .select('-__v')
      .lean();

    const hasMore = products.length > Number(limit);
    const data = hasMore ? products.slice(0, -1) : products;
    const nextCursor = hasMore ? data[data.length - 1]._id : null;

    // 🚀 ULTRA PERFORMANCE: Batch-fetch ALL inventory for this page in ONE query
    // Eliminates the N+1 problem: was (N * SyncService.calculateTrueStock) = N DB calls
    const pageProductIds = data.map(p => p._id);
    const pageInventoryRecords = await Inventory.find({
      $or: [
        { productRef: { $in: pageProductIds } },
        { productName: { $in: data.map(p => p.name) }, productRef: null }
      ],
      isDeleted: { $ne: true }
    }).lean();

    // Build lookup map: productId -> [inventoryItems]
    const invMap = pageInventoryRecords.reduce((acc, inv) => {
      const key = inv.productRef ? String(inv.productRef) : `name:${inv.productName}`;
      if (!acc[key]) acc[key] = [];
      acc[key].push(inv);
      return acc;
    }, {});

    // Fire-and-forget orphan healing (non-blocking)
    pageInventoryRecords
      .filter(inv => !inv.productRef && inv.productName)
      .forEach(inv => {
        const matchingProduct = data.find(p => p.name === inv.productName);
        if (matchingProduct) {
          Inventory.updateOne({ _id: inv._id }, { $set: { productRef: matchingProduct._id } })
            .catch(err => logger.warn(`[Healing] ${err.message}`));
        }
      });

    const processedProducts = await Promise.all(data.map(async (p) => {
      const byRef = invMap[String(p._id)] || [];
      const byName = invMap[`name:${p.name}`] || [];
      const invItems = [...byRef, ...byName];
      
      let liveStock;
      if (p.productNature === 'combo') {
        // Derive combo stock from component variants
        liveStock = await stockService.getComboProductStock(p._id);
      } else {
        // Aggregate standalone stock from inventory collection
        const totalStock = invItems.reduce((sum, inv) => sum + (inv.totalStock || 0), 0);
        const availableStock = invItems.reduce((sum, inv) => {
          const avail = Math.max(0, (inv.totalStock + (inv.returned || 0)) -
            (inv.onlineSold + inv.offlineSold + (inv.reservedStock || 0) + (inv.damaged || 0)));
          return sum + avail;
        }, 0);
        const reservedStock = invItems.reduce((sum, inv) => sum + (inv.reservedStock || 0), 0);
        
        liveStock = {
          totalStock,
          availableStock,
          reservedStock,
          variantCount: invItems.length
        };
      }

      return {
        ...p,
        liveStock,
        // Legacy support for older components
        availableStock: liveStock.availableStock,
        totalStock: liveStock.totalStock
      };
    }));

    // Parallelize all count queries in ONE Promise.all (was 4 serial queries)
    const statsQuery = { ...query };
    delete statsQuery._id;
    
    const [onlineCount, billingCount, inventoryAgg, totalProfileCount] = await Promise.all([
       Product.countDocuments({ ...statsQuery, isOnlineProduct: true }),
       Product.countDocuments({ ...statsQuery, isBillingProduct: true }),
       Inventory.aggregate([
         { $match: { productRef: { $in: pageProductIds }, isDeleted: { $ne: true } } },
         { $group: { _id: null, totalStock: { $sum: '$totalStock' } } }
       ]),
       Product.countDocuments(statsQuery)
    ]);

    return ApiResponse.success(res, {
      data: processedProducts,
      nextCursor,
      hasMore,
      stats: {
         onlineEnabled: onlineCount,
         billingEnabled: billingCount,
         procuredStock: inventoryAgg[0]?.totalStock || 0,
         totalProfiles: totalProfileCount
      }
    });

  } catch (error) { next(error); }
};

// GET /products/admin/:id
exports.getAdminProductById = async (req, res, next) => {
  try {
    const product = await Product.findOne({ _id: req.params.id, isDeleted: { $ne: true } }).populate('category', 'name slug').lean();
    if (!product) return ApiResponse.notFound(res, 'Product not found');
    
    // Resolve live stock and sync variants
    const SyncService = require('../services/sync.service');
    const trueStock = await SyncService.calculateTrueStock(product);
    product.variants = trueStock.variants;
    product.availableStock = trueStock.availableStock;
    product.totalStock = trueStock.totalStock;

    return ApiResponse.success(res, { product });
  } catch (error) { next(error); }
};

// GET /products/:slug (Public Detail)
exports.getProduct = async (req, res, next) => {
  try {
    const { slug } = req.params;
    const { isPOS } = req.query;

    const query = { isDeleted: { $ne: true } };
    
    if (mongoose.Types.ObjectId.isValid(slug)) {
      query._id = slug;
    } else {
      query.slug = slug;
    }

    const { isAdmin } = req.query;
    if (isAdmin !== 'true') {
      query.isArchived = { $ne: true };
    }

    if (isPOS !== 'true') query.isActive = true;

    const product = await Product.findOne(query)
      .populate('category', 'name slug')
      .lean();
      
    if (!product) return ApiResponse.notFound(res, 'Product not found');

    // Add view count
    if (isPOS !== 'true') {
       await Product.findByIdAndUpdate(product._id, { $inc: { viewCount: 1 } }).exec();
    }

    // Resolve live stock
    const SyncService = require('../services/sync.service');
    const trueStock = await SyncService.calculateTrueStock(product);
    product.variants = trueStock.variants;
    product.availableStock = trueStock.availableStock;
    product.totalStock = trueStock.totalStock;

    return ApiResponse.success(res, { product });
  } catch (error) { next(error); }
};

// GET /products/search
exports.searchProducts = async (req, res, next) => {
  try {
    const { q, limit = 8, isPOS } = req.query;
    if (!q || q.length < 2) return ApiResponse.success(res, { products: [] });
    
    const query = {
      $or: [
        { name: { $regex: q, $options: 'i' } },
        { sku: { $regex: q, $options: 'i' } }
      ],
      isDeleted: { $ne: true },
      isArchived: { $ne: true }
    };

    if (isPOS === 'true') {
       query.isBillingProduct = true;
    } else {
       query.isOnlineProduct = true;
       query.isActive = true;
    }

    const products = await Product.find(query)
      .select('name sku slug images thumbnail sellingPrice discountedPrice isActive variants availableStock category')
      .populate('category', 'name')
      .limit(Number(limit))
      .lean();

    const SyncService = require('../services/sync.service');
    const processedProducts = await Promise.all(products.map(async p => {
       const trueStock = await SyncService.calculateTrueStock(p);
       return {
          ...p,
          variants: trueStock.variants,
          availableStock: trueStock.availableStock,
          syncedVariants: trueStock.variants 
       };
    }));

    return ApiResponse.success(res, { products: processedProducts });
  } catch (error) { next(error); }
};

// POST /products (Admin)
exports.createProduct = async (req, res, next) => {
  const tx = await startTransactionSession();
  const session = tx.session;
  try {
    const data = req.body;
    if (data.variants && Array.isArray(data.variants)) {
      data.variants = data.variants.map(v => {
        if (v._id && String(v._id).startsWith('temp-')) {
          const { _id, ...rest } = v;
          return rest;
        }
        return v;
      });
    }
    if (!data.name) {
      await tx.abortTransaction();
      return ApiResponse.error(res, 'Product name is required', 400);
    }
    
    // Ensure default visibility if not provided
    if (data.isOnlineProduct === undefined) data.isOnlineProduct = true;
    if (data.isBillingProduct === undefined) data.isBillingProduct = true;
    if (data.isInventoryProduct === undefined) data.isInventoryProduct = true;
    if (data.isActive === undefined) data.isActive = true;

    // Generate unique slug
    let slug = slugify(data.name, { lower: true, strict: true });
    const slugExists = await (session ? Product.findOne({ slug }).session(session) : Product.findOne({ slug }));
    if (slugExists) {
      slug = `${slug}-${Math.random().toString(36).substring(2, 7)}`;
    }
    data.slug = slug;

    if (!data.sku) data.sku = generateSKU(data.category);

    const product = await Product.create([data], session ? { session } : {});
    const newProduct = product[0];

    // NEW: Trigger immediate inventory sync for initial variants if any
    await SyncService.syncProfileToInventory(newProduct._id, data, session);

    await tx.commitTransaction();
    return ApiResponse.created(res, newProduct, 'Product Profile Created Successfully');
  } catch (error) { 
    await tx.abortTransaction();
    next(error); 
  } finally {
    await tx.endSession();
  }
};

// POST /products/with-procurement (Admin)
exports.createProductWithProcurement = async (req, res, next) => {
  const tx = await startTransactionSession();
  const session = tx.session;
  try {
    const { productData, procurementData } = req.body;
    if (productData && productData.variants && Array.isArray(productData.variants)) {
      productData.variants = productData.variants.map(v => {
        if (v._id && String(v._id).startsWith('temp-')) {
          const { _id, ...rest } = v;
          return rest;
        }
        return v;
      });
    }
    
    if (!productData.name) {
       await tx.abortTransaction();
       return ApiResponse.error(res, 'Product name is required', 400);
    }

    // 1. Create Product Profile
    // Generate unique slug
    let slug = slugify(productData.name, { lower: true, strict: true });
    const slugExists = await (session ? Product.findOne({ slug }).session(session) : Product.findOne({ slug }));
    if (slugExists) {
      slug = `${slug}-${Math.random().toString(36).substring(2, 7)}`;
    }
    productData.slug = slug;
    if (!productData.sku) productData.sku = generateSKU(productData.category);

    const product = await Product.create([productData], session ? { session } : {});
    const newProduct = product[0];

    // 2. Create Purchase Bill if data exists
    if (procurementData && procurementData.supplierId && procurementData.items?.length > 0) {
       const subtotal = procurementData.items.reduce((sum, item) => sum + (item.quantity * item.costPrice), 0);
       
       const purchaseData = {
          purchaseNumber: generatePurchaseNumber(),
          billNumber: procurementData.billNumber,
          supplierId: procurementData.supplierId,
          billDate: procurementData.billDate || new Date(),
          billImage: procurementData.billImage,
          status: 'received',
          paymentStatus: 'pending',
          items: procurementData.items.map(item => ({
             productId: item.productId || newProduct._id,
             productName: item.productName || newProduct.name,
             sku: item.sku || newProduct.sku,
             size: item.size,
             color: item.color,
             quantity: item.quantity,
             costPrice: item.costPrice,
             sellingPrice: item.sellingPrice,
             total: item.quantity * item.costPrice
          })),
          pricing: {
             subtotal,
             totalAmount: subtotal, // Assuming no GST for simplicity here, or use default
             gstAmount: 0
          },
          performedBy: req.user._id
       };

       const purchase = await Purchase.create([purchaseData], session ? { session } : {});
       const newPurchase = purchase[0];

       // 3. Process Purchase (Sync to Inventory)
       await SyncService.syncPurchaseToCatalog(newPurchase._id, req.user._id, session);
    } else {
       // NEW: If no procurement recorded, still sync profile to create empty inventory records
       await SyncService.syncProfileToInventory(newProduct._id, productData, session);
    }

    await tx.commitTransaction();
    return ApiResponse.created(res, newProduct, 'Product Profile and Procurement recorded successfully');

  } catch (error) {
    await tx.abortTransaction();
    next(error);
  } finally {
    await tx.endSession();
  }
};

// PATCH /products/:id (Admin)
exports.updateProduct = async (req, res, next) => {
  const tx = await startTransactionSession();
  const session = tx.session;
  try {
    const { id } = req.params;
    const updateData = req.body;
    if (updateData.variants && Array.isArray(updateData.variants)) {
      updateData.variants = updateData.variants.map(v => {
        if (v._id && String(v._id).startsWith('temp-')) {
          const { _id, ...rest } = v;
          return rest;
        }
        return v;
      });
    }

    const product = await (session ? Product.findById(id).session(session) : Product.findById(id));
    if (!product) {
      await tx.abortTransaction();
      return ApiResponse.notFound(res, 'Product not found');
    }

    // Capture old images for cleanup
    const oldImages = new Set([
      product.thumbnail,
      ...(product.images || []),
      product.laptopImage,
      product.tabletImage,
      product.mobileImage,
      ...(product.variants || []).flatMap(v => v.images || [])
    ].filter(Boolean));

    Object.assign(product, updateData);
    await (session ? product.save({ session }) : product.save());
    
    // Cascade changes to Inventory
    await SyncService.syncProfileToInventory(id, updateData, session);

    // Capture new images to find orphans (filter out deleted variants so their images are cleaned up)
    const newImages = new Set([
      product.thumbnail,
      ...(product.images || []),
      product.laptopImage,
      product.tabletImage,
      product.mobileImage,
      ...(product.variants || []).filter(v => !v.isDeleted).flatMap(v => v.images || [])
    ].filter(Boolean));

    const orphanedImages = [...oldImages].filter(url => !newImages.has(url) && url.includes('res.cloudinary.com'));
    
    await tx.commitTransaction();

    // Fire-and-forget cleanup of orphaned images
    if (orphanedImages.length > 0) {
      const { deleteMultipleCloudinaryAssets } = require('../utils/cloudinaryHelper');
      deleteMultipleCloudinaryAssets(orphanedImages).catch(err => console.error('[Cleanup Orphaned Images Failed]', err));
    }

    try {
      const { getIO } = require('../utils/socket');
      const io = getIO();
      if (io) {
         io.emit('STOCK_UPDATED', { productId: id });
      }
    } catch (socketErr) {
      console.warn('[SyncService] Socket emission failed:', socketErr.message);
    }

    return ApiResponse.success(res, product);
  } catch (error) { 
    await tx.abortTransaction();
    next(error); 
  } finally {
    await tx.endSession();
  }
};

// DELETE /products/:id (Admin)
exports.deleteProduct = async (req, res, next) => {
  const { startTransactionSession } = require('../utils/transaction');
  const { deleteCloudinaryAsset } = require('../utils/cloudinaryHelper');
  const Order = require('../models/Order');
  const Bill = require('../models/Bill');
  const { getIO } = require('../utils/socket');
  const io = getIO();

  const { id } = req.params;
  const tx = await startTransactionSession();

  try {
    const product = await Product.findById(id).session(tx.session);
    if (!product) {
      await tx.abortTransaction();
      await tx.endSession();
      return ApiResponse.notFound(res, 'Product not found');
    }

    // 1. Referential Integrity Shield: Check if this item is in order/billing history
    const hasOrders = await Order.exists({ 'items.productId': id }).session(tx.session);
    const hasBills = await Bill.exists({ 'items.productId': id }).session(tx.session);

    if (hasOrders || hasBills) {
      // Perform Soft-Delete (Archival) to protect historical financial integrity
      logger.info(`[ProductController] Soft-deleting/Archiving product ${product.name} (Linked to Sales History)`);
      
      product.isArchived = true;
      product.isActive = false;
      product.archivedAt = new Date();
      product.archivedBy = req.user._id;
      await product.save({ session: tx.session });

      // Disable associated inventory records
      await Inventory.updateMany(
        { productRef: id },
        { 
          $set: { 
            isArchived: true, 
            archivedAt: new Date(), 
            onlineEnabled: false, 
            offlineEnabled: false 
          } 
        },
        { session: tx.session }
      );

      await tx.commitTransaction();

      // Emit live update to the UI
      if (io) {
        io.emit('PRODUCT_ARCHIVED', { id, name: product.name });
      }

      return ApiResponse.success(res, { 
        archived: true, 
        message: 'Product is linked to historical invoice transactions. It has been safely archived, and linked inventory channels have been deactivated.' 
      });
    }

    // 2. Safe Hard-Delete (If no sales history exists)
    logger.warn(`[ProductController] PERMANENT CASCADE DELETE initiated for: ${product.name} by User: ${req.user._id}`);

    // Gather all image URLs for cleanup before removing from database
    const imageUrls = [];
    if (product.thumbnail) imageUrls.push(product.thumbnail);
    if (product.images && product.images.length > 0) imageUrls.push(...product.images);
    if (product.laptopImage) imageUrls.push(product.laptopImage);
    if (product.tabletImage) imageUrls.push(product.tabletImage);
    if (product.mobileImage) imageUrls.push(product.mobileImage);
    if (product.variants && product.variants.length > 0) {
      product.variants.forEach(v => {
        if (v.images && v.images.length > 0) imageUrls.push(...v.images);
      });
    }

    const linkedInventories = await Inventory.find({ productRef: id }).session(tx.session);
    linkedInventories.forEach(inv => {
      if (inv.images && inv.images.length > 0) imageUrls.push(...inv.images);
      if (inv.laptopImage) imageUrls.push(inv.laptopImage);
      if (inv.tabletImage) imageUrls.push(inv.tabletImage);
      if (inv.mobileImage) imageUrls.push(inv.mobileImage);
      if (inv.thumbnail) imageUrls.push(inv.thumbnail);
    });

    // Strip duplicates and clean up Cloudinary assets
    const uniqueUrls = [...new Set(imageUrls)].filter(Boolean);
    for (const url of uniqueUrls) {
      // Fire-and-forget delete (failure does not block database transaction integrity)
      deleteCloudinaryAsset(url).catch(err => logger.error(`[Cloudinary Cleanup Error] ${err.message}`));
    }

    // Cascade delete database records atomically within transaction session
    await Inventory.deleteMany({ productRef: id }, { session: tx.session });
    await StockMovement.deleteMany({ productId: id }, { session: tx.session });
    await Product.findByIdAndDelete(id, { session: tx.session });

    await tx.commitTransaction();

    // Emit live update to the UI
    if (io) {
      io.emit('PRODUCT_PURGED', { id, name: product.name });
    }

    return ApiResponse.success(res, { 
      deleted: true, 
      message: 'Product, associated inventory variants, stock histories, and cloud media assets have been successfully and permanently purged.' 
    });

  } catch (error) { 
    await tx.abortTransaction();
    next(error); 
  } finally {
    await tx.endSession();
  }
};

exports.purgeProduct = async (req, res, next) => {
  try {
    const { id } = req.params;
    const result = await SyncService.purgeProduct(id, req.user._id);
    return ApiResponse.success(res, result, result.message);
  } catch (error) { next(error); }
};

exports.restoreProduct = async (req, res, next) => {
  try {
    const { id } = req.params;
    const product = await Product.findById(id);
    if (!product) return ApiResponse.notFound(res, 'Product profile not found');

    await Product.findByIdAndUpdate(id, { 
      isActive: true, 
      isDeleted: false,
      deletedAt: null,
      isOnlineProduct: true,
      isBillingProduct: true,
      isInventoryProduct: true
    });

    // Optionally restore variants that were archived
    const Inventory = require('../models/Inventory');
    await Inventory.updateMany(
      { productRef: id, isDeleted: true }, 
      { isDeleted: false, deletedAt: null }
    );

    return ApiResponse.success(res, { restored: true }, 'Product profile and variants restored successfully');
  } catch (error) { next(error); }
};

// GET /pos/products/:productId/variants (IMPLEMENT FIX 5)
exports.getPOSProductVariants = async (req, res, next) => {
  try {
    const { productId } = req.params;
    let product = await Product.findById(productId).select('name productNature comboSlots sellingPrice discountedPrice images thumbnail');

    if (!product) {
      // 🛡️ HARDENING: Fallback to resolve master Product if given an Inventory ID
      const Inventory = require('../models/Inventory');
      const invRecord = await Inventory.findById(productId);
      if (invRecord && invRecord.productRef) {
        product = await Product.findById(invRecord.productRef).select('name productNature comboSlots sellingPrice discountedPrice images thumbnail');
      }
    }

    if (!product) return ApiResponse.notFound(res, 'Product not found');

    let variants;
    if (product.productNature === 'combo') {
      const { variantStockMap } = await stockService.getComboProductStock(productId);
      variants = Object.values(variantStockMap);
    } else {
      const invRecords = await Inventory.find({ productRef: productId, isDeleted: { $ne: true } }).lean();
      variants = invRecords.map(inv => {
        const avail = Math.max(0, (inv.totalStock + (inv.returned || 0)) -
          (inv.onlineSold + inv.offlineSold + (inv.reservedStock || 0) + (inv.damaged || 0)));
        return {
          ...inv,
          sellingPrice: product.discountedPrice || inv.sellingPrice || product.sellingPrice,
          availableStock: avail,
          inStock: avail > 0,
          stockLabel: avail > 0 ? `${avail} IN STOCK` : 'OUT OF STOCK'
        };
      });

      if (variants.length === 0) {
         variants = [{
            _id: `virtual-${product._id}`,
            productRef: product._id,
            productName: product.name,
            sku: product.sku || 'N/A',
            size: 'Standard',
            color: 'Standard',
            sellingPrice: product.discountedPrice || product.sellingPrice || 0,
            availableStock: 0,
            inStock: true,
            stockLabel: '0 STOCK (Offline Billing Allowed)'
         }];
      }
    }

    console.log('[getPOSProductVariants] Returning variants for POS:', variants?.length);
    return ApiResponse.success(res, {
      product,
      variants
    });
  } catch (error) { next(error); }
};

// GET /products/barcode/:code (POS Barcode Lookup — Retsol LS Scanner)
exports.getProductByBarcode = async (req, res, next) => {
  try {
    const { code } = req.params;
    if (!code) return ApiResponse.error(res, 'Barcode is required', 400);

    // Search product-level barcode AND variant-level barcode AND SKU
    const product = await Product.findOne({
      $or: [
        { barcode: code },
        { sku: code.toUpperCase() },
        { 'variants.barcode': code },
        { 'variants.sku': code.toUpperCase() }
      ],
      isBillingProduct: true,
      isDeleted: { $ne: true },
      isArchived: { $ne: true }
    })
    .populate('category', 'name slug')
    .lean();

    if (!product) {
      return ApiResponse.notFound(res, `No product found for barcode: ${code}`);
    }

    // Get live inventory variants for this product
    const invRecords = await Inventory.find({
      productRef: product._id,
      isDeleted: { $ne: true }
    }).lean();

    const variants = invRecords.map(inv => {
      const avail = Math.max(0,
        (inv.totalStock + (inv.returned || 0)) -
        (inv.onlineSold + inv.offlineSold + (inv.reservedStock || 0) + (inv.damaged || 0))
      );
      return { ...inv, availableStock: avail };
    });

    // Find the exact matched variant if barcode is variant-level
    const matchedVariant = variants.find(
      v => v.barcode === code || v.sku === code.toUpperCase()
    );

    return ApiResponse.success(res, {
      product: { ...product, variants },
      matchedVariant: matchedVariant || null
    });

  } catch (error) { next(error); }
};
