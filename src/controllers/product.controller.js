const Product = require('../models/Product');
const Category = require('../models/Category');
const StockMovement = require('../models/StockMovement');
const ApiResponse = require('../utils/apiResponse');
const slugify = require('slugify');
const { generateSKU } = require('../utils/generateNumbers');
const { sendProductNotificationToAdmin } = require('../services/whatsapp.service');

// GET /products
exports.getProducts = async (req, res, next) => {
  try {
    const {
      page = 1, limit = 20, category, search, minPrice, maxPrice, size,
      sort = '-createdAt', isFeatured, isBestSeller, isNewArrival,
      isPOS,
    } = req.query;

    console.log('DEBUG [getProducts]:', { category, size, isPOS, minPrice, maxPrice });

    const skip = (Number(page) - 1) * Number(limit);
    const limitNum = Number(limit);

    const Inventory = require('../models/Inventory');
    const mongoose = require('mongoose');

    // ─── 1. Build Inventory Match ────────────────────────────
    const invMatch = {};
    if (isPOS === 'true') {
      invMatch.offlineEnabled = true;
    } else {
      invMatch.onlineEnabled = true;
    }

    if (category && !search) {
      // If it's a valid ID, match it directly. Otherwise, we'll filter by slug later in the pipeline
      if (mongoose.Types.ObjectId.isValid(category)) {
        invMatch.category = category;
      }
    }

    // Size filter (from comma separated string)
    if (size) {
      const sizeArray = size.split(',').filter(Boolean);
      if (sizeArray.length > 0) {
        invMatch.size = { $in: sizeArray };
      }
    }

    // ─── 2. Aggregation Pipeline ──────────────────────────────
    const pipeline = [
      { $match: invMatch },
      // Group by product (linked by productRef or productName)
      { $group: {
          _id: { $ifNull: ['$productRef', '$productName'] },
          name: { $first: '$productName' },
          categoryName: { $first: '$category' },
          productRef: { $first: '$productRef' },
          variants: { $push: {
            size: '$size',
            color: '$color',
            // Calculate LIVE stock to avoid stale availableStock field
            stock: { $max: [0, { $subtract: [
               { $add: [{ $ifNull: ['$totalStock', 0] }, { $ifNull: ['$returned', 0] }] },
               { $add: [{ $ifNull: ['$onlineSold', 0] }, { $ifNull: ['$offlineSold', 0] }, { $ifNull: ['$reservedStock', 0] }, { $ifNull: ['$damaged', 0] }] }
            ]}] },
            price: '$sellingPrice',
            sku: '$sku',
            barcode: '$barcode'
          }},
          images: { $first: '$images' },
          sellingPrice: { $max: '$sellingPrice' },
          createdAt: { $max: '$createdAt' }
      }},
      // Join Product details if linked
      { $lookup: {
          from: 'products',
          localField: 'productRef',
          foreignField: '_id',
          as: 'productDetails'
      }},
      { $unwind: { path: '$productDetails', preserveNullAndEmptyArrays: true } },
      // Merge Product details into root
      { $addFields: {
          name: { $ifNull: ['$productDetails.name', '$name'] },
          sku: { $ifNull: ['$productDetails.sku', { $arrayElemAt: ['$variants.sku', 0] }] },
          slug: '$productDetails.slug',
          isActive: { $ifNull: ['$productDetails.isActive', true] },
          images: { $ifNull: ['$productDetails.images', '$images'] },
          category: { $ifNull: ['$productDetails.category', '$categoryName'] },
          availableStock: { $sum: '$variants.stock' }
      }},
      // Join Category details if category is just a string/name (to get slug/details)
      { $lookup: {
          from: 'categories',
          let: { catId: '$category' },
          pipeline: [
            { $match: { $expr: { $or: [{ $eq: ['$_id', '$$catId'] }, { $eq: ['$name', '$$catId'] }] } } }
          ],
          as: 'categoryDetails'
      }},
      { $unwind: { path: '$categoryDetails', preserveNullAndEmptyArrays: true } },
      { $addFields: { categorySlug: '$categoryDetails.slug' } },

      // ─── CRITICAL LOGIC FIX ───
      // Final Match for Price, Size, Category Slug, Profile existence, and Advanced Search
      { $match: {
          ...(isPOS === 'true' ? {} : { productRef: { $ne: null }, isActive: true }),
          ...(minPrice ? { sellingPrice: { $gte: Number(minPrice) } } : {}),
          ...(maxPrice ? { sellingPrice: { ...((minPrice ? { $gte: Number(minPrice) } : {})), $lte: Number(maxPrice) } } : {}),
          ...(category && !mongoose.Types.ObjectId.isValid(category) ? { categorySlug: category } : {}),
          ...(isFeatured === 'true' ? { 'productDetails.isFeatured': true } : {}),
          ...(isBestSeller === 'true' ? { 'productDetails.isBestSeller': true } : {}),
          ...(isNewArrival === 'true' ? { 'productDetails.isNewArrival': true } : {}),
          
          // Advanced Search (High Level)
          ...(search ? {
            $or: [
              { name: new RegExp(search, 'i') },
              { 'productDetails.description': new RegExp(search, 'i') },
              { category: new RegExp(search, 'i') },
              { categorySlug: new RegExp(search, 'i') },
              { sku: new RegExp(search, 'i') },
              { barcode: new RegExp(search, 'i') },
              // If search is a number, match price exactly or near
              ...(!isNaN(search) ? [{ sellingPrice: { $gte: Number(search) - 50, $lte: Number(search) + 50 } }] : [])
            ]
          } : {})
      }},
      
      // Sorting
      { $sort: sort === 'price-asc' ? { sellingPrice: 1 } : sort === 'price-desc' ? { sellingPrice: -1 } : { createdAt: -1 } },
      // Pagination
      { $facet: {
          metadata: [ { $count: 'total' } ],
          data: [ { $skip: skip }, { $limit: limitNum } ]
      }}
    ];

    const [results] = await Inventory.aggregate(pipeline);
    
    const total = results.metadata[0]?.total || 0;
    const products = results.data;

    // Cache for 1 hour (3600s), allow stale for 1 day (86400s)
    res.set('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400');

    return ApiResponse.paginated(res, products, {
      page: Number(page), limit: Number(limit),
      total, pages: Math.ceil(total / Number(limit)),
    });
  } catch (error) { next(error); }
};

// GET /products/admin (Admin - No changes needed to query logic, but adding inventory merge)
exports.getAdminProducts = async (req, res, next) => {
  try {
    const { category, search, sort = 'newest', page = 1, limit = 100 } = req.query;
    const query = {};

    if (category) query.category = category;
    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { sku: { $regex: search, $options: 'i' } }
      ];
    }

    const sortMap = {
      'newest': { createdAt: -1 },
      'oldest': { createdAt: 1 },
      'price-high': { sellingPrice: -1 },
      'price-low': { sellingPrice: 1 },
    };

    const skip = (Number(page) - 1) * Number(limit);

    const products = await Product.find(query)
      .populate('category', 'name slug')
      .sort(sortMap[sort] || { createdAt: -1 })
      .skip(skip)
      .limit(Number(limit))
      .select('-__v');

    const total = await Product.countDocuments(query);

    // ─── INJECT AGGREGATED INVENTORY ───
    const productIds = products.map(p => p._id);
    const Inventory = require('../models/Inventory');
    const allInventory = await Inventory.find({ productRef: { $in: productIds } }).lean({ virtuals: true });

    const inventoryMap = allInventory.reduce((acc, item) => {
      const pId = item.productRef.toString();
      if (!acc[pId]) acc[pId] = { totalStock: 0, sizes: new Set(), colors: new Set(), variantCount: 0 };
      
      const avail = Math.max(0, (item.totalStock + (item.returned || 0)) - ((item.onlineSold || 0) + (item.offlineSold || 0) + (item.reservedStock || 0) + (item.damaged || 0)));
      acc[pId].totalStock += avail;
      if (item.size) acc[pId].sizes.add(item.size);
      if (item.color) acc[pId].colors.add(item.color);
      acc[pId].variantCount++;
      return acc;
    }, {});

    const processedProducts = products.map(p => {
      const inv = inventoryMap[p._id.toString()] || { totalStock: 0, sizes: new Set(), colors: new Set(), variantCount: 0 };
      return {
        ...p.toObject(),
        inventorySummary: {
          totalStock: inv.totalStock,
          sizes: Array.from(inv.sizes),
          colors: Array.from(inv.colors),
          variantCount: inv.variantCount
        }
      };
    });

    return ApiResponse.paginated(res, processedProducts, {
      page: Number(page), limit: Number(limit), total,
      pages: Math.ceil(total / Number(limit))
    });
  } catch (error) { next(error); }
};

// GET /products/admin/:id (Admin)
exports.getAdminProductById = async (req, res, next) => {
  try {
    const product = await Product.findById(req.params.id).populate('category', 'name slug');
    if (!product) return ApiResponse.notFound(res, 'Product not found');
    return ApiResponse.success(res, { product });
  } catch (error) { next(error); }
};

// GET /products/:slug
exports.getProduct = async (req, res, next) => {
  try {
    const { slug } = req.params;
    if (!slug || slug === 'undefined' || slug === 'null') {
      return ApiResponse.notFound(res, 'Product identifier missing');
    }
    const { isPOS } = req.query;
    const Inventory = require('../models/Inventory');

    let product = null;
    let variants = [];
    let isVirtual = false;

    // 1. Try finding by Slug first (Standard Product)
    const pQuery = { slug };
    if (isPOS !== 'true') pQuery.isActive = true;
    product = await Product.findOne(pQuery).populate('category', 'name slug').select('-costPrice -__v');

    if (!product) {
      // 2. Try finding by Barcode in Inventory (Crucial for POS Scanning)
      const invByBarcode = await Inventory.findOne({ 
        barcode: slug,
        ...(isPOS === 'true' ? { offlineEnabled: true } : { onlineEnabled: true })
      }).lean();

      if (invByBarcode) {
        // Find all siblings (other sizes/colors) of this virtual product
        const siblings = await Inventory.find({
          productName: invByBarcode.productName,
          productRef: null,
          ...(isPOS === 'true' ? { offlineEnabled: true } : { onlineEnabled: true })
        }).lean();

        isVirtual = true;
        product = {
          _id: `unlinked-${invByBarcode.productName}`,
          name: invByBarcode.productName,
          category: { name: invByBarcode.category || 'Uncategorized' },
          sellingPrice: invByBarcode.sellingPrice,
          images: invByBarcode.images || [],
          isVirtual: true,
          isActive: true
        };
        variants = siblings;
      } else {
        // 3. Try finding by productName directly in unlinked inventory
        const unlinkedItems = await Inventory.find({
          productName: slug,
          productRef: null,
          ...(isPOS === 'true' ? { offlineEnabled: true } : { onlineEnabled: true })
        }).lean();

        if (unlinkedItems.length > 0) {
          isVirtual = true;
          product = {
            _id: `unlinked-${unlinkedItems[0].productName}`,
            name: unlinkedItems[0].productName,
            category: { name: unlinkedItems[0].category || 'Uncategorized' },
            sellingPrice: unlinkedItems[0].sellingPrice,
            images: unlinkedItems[0].images || [],
            isVirtual: true,
            isActive: true
          };
          variants = unlinkedItems;
        }
      }
    }

    if (!product) return ApiResponse.notFound(res, 'Product not found');

    // 4. Fetch Variants for standard product if not already set (Virtual case sets them)
    if (!isVirtual) {
      const liveItems = await Inventory.find({ 
        $or: [
          { productRef: product._id },
          { productName: { $regex: new RegExp('^' + product.name.trim() + '$', 'i') } }
        ],
        ...(isPOS === 'true' ? { offlineEnabled: true } : { onlineEnabled: true })
      }).lean();
      variants = liveItems;
    }

    // 5. Format Output
    const formattedVariants = variants.map(inv => {
      const stock = Math.max(0, (inv.totalStock || 0) + (inv.returned || 0) - (inv.onlineSold || 0) - (inv.offlineSold || 0) - (inv.reservedStock || 0) - (inv.damaged || 0));
      return {
        size:     inv.size,
        color:    inv.color,
        stock:    stock,
        price:    inv.sellingPrice || product.sellingPrice,
        sku:      inv.sku || product.sku,
        barcode:  inv.barcode,
        _id:      inv._id,
      };
    });

    const productObj = product.toObject ? product.toObject() : product;
    productObj.variants = formattedVariants;
    productObj.availableStock = formattedVariants.reduce((sum, v) => sum + v.stock, 0);

    if (!isVirtual) {
      Product.findByIdAndUpdate(product._id, { $inc: { viewCount: 1 } }).exec();
    }
    
    // Cache for 1 hour
    res.set('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400');
    
    return ApiResponse.success(res, { product: productObj });
  } catch (error) { next(error); }
};

// GET /products/search
exports.searchProducts = async (req, res, next) => {
  try {
    const { q, limit = 8 } = req.query;
    if (!q || q.length < 2) return ApiResponse.success(res, { products: [] });
    
    const query = {
      $or: [
        { name: { $regex: q, $options: 'i' } },
        { sku: { $regex: q, $options: 'i' } },
        { tags: { $in: [new RegExp(q, 'i')] } },
      ],
    };

    if (req.query.isPOS !== 'true') {
      query.isActive = true;
    }

    const products = await Product.find(query)

    // For search results, we can just return the display profiles
    // The frontend usually navigates to details where we fetch live stock
    return ApiResponse.success(res, { products });
  } catch (error) { next(error); }
};

// POST /products (Admin)
exports.createProduct = async (req, res, next) => {
  try {
    const data = req.body;
    if (!data.name) return ApiResponse.error(res, 'Product name is required', 400);
    
    // 1. Generate unique slug
    let slug = slugify(data.name, { lower: true, strict: true });
    const slugExists = await Product.findOne({ slug });
    if (slugExists) {
      slug = `${slug}-${Math.random().toString(36).substring(2, 7)}`;
    }
    data.slug = slug;

    if (!data.sku) data.sku = generateSKU(data.category);

    const product = await Product.create(data);
    
    // 2. Link existing inventory items by name
    const Inventory = require('../models/Inventory');
    await Inventory.updateMany(
      { productName: { $regex: new RegExp('^' + product.name.trim() + '$', 'i') } },
      { productRef: product._id }
    );
    
    // Notify Admin via WhatsApp
    sendProductNotificationToAdmin(product, 'created').catch(() => {});

    return ApiResponse.created(res, { product }, 'Product created successfully');
  } catch (error) {
    if (error.code === 11000) {
      const field = Object.keys(error.keyPattern || {})[0] || 'unique field';
      return ApiResponse.error(res, `A product with this ${field} already exists.`, 400);
    }
    next(error);
  }
};

// PUT /products/:id (Admin)
exports.updateProduct = async (req, res, next) => {
  try {
    const data = { ...req.body };
    const product = await Product.findById(req.params.id);
    if (!product) return ApiResponse.notFound(res, 'Product not found');

    // 1. Unique checks for SKU
    if (data.sku && data.sku !== product.sku) {
      const skuExists = await Product.findOne({ sku: data.sku, _id: { $ne: product._id } });
      if (skuExists) return ApiResponse.error(res, 'SKU already exists', 400);
    }

    // 2. Slug Regeneration (if name changed)
    if (data.name && data.name !== product.name) {
      let slug = slugify(data.name, { lower: true, strict: true });
      const slugExists = await Product.findOne({ slug, _id: { $ne: product._id } });
      if (slugExists) {
        slug = `${slug}-${Math.random().toString(36).substring(2, 7)}`;
      }
      product.slug = slug;
      
      // ERP Logic: Re-link inventory if name changes
      const Inventory = require('../models/Inventory');
      // 1. Unlink old ones
      await Inventory.updateMany({ productRef: product._id }, { productRef: null });
      // 2. Link new ones
      await Inventory.updateMany(
        { productName: { $regex: new RegExp('^' + data.name.trim() + '$', 'i') } },
        { productRef: product._id }
      );
    }

    // 3. Manual Merge
    const excludedFields = ['_id', 'id', 'slug', 'createdAt', 'updatedAt', '__v', 'totalStock', 'availableStock'];
    Object.keys(data).forEach(key => {
      if (!excludedFields.includes(key)) {
        product[key] = data[key];
      }
    });

    // 4. Save (triggers pre-save hooks for discountedPrice)
    const updatedProduct = await product.save();

    // 5. Notify Admin
    sendProductNotificationToAdmin(updatedProduct, 'updated').catch(() => {});

    return ApiResponse.success(res, { product: updatedProduct }, 'Product updated successfully');
  } catch (error) {
    if (error.code === 11000) {
      const field = Object.keys(error.keyPattern || {})[0] || 'unique field';
      return ApiResponse.error(res, `A product with this ${field} already exists.`, 400);
    }
    next(error);
  }
};

// DELETE /products/:id (Admin)
exports.deleteProduct = async (req, res, next) => {
  try {
    const product = await Product.findByIdAndDelete(req.params.id);
    if (!product) return ApiResponse.notFound(res, 'Product not found');
    
    // Unlink inventory
    const Inventory = require('../models/Inventory');
    await Inventory.updateMany({ productRef: product._id }, { productRef: null });

    return ApiResponse.success(res, null, 'Product deleted permanently');
  } catch (error) { next(error); }
};

// adjustStock has been moved to inventory.controller.js
// Use PUT /api/v1/admin/inventory/:id/adjust instead
