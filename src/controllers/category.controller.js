const Category = require('../models/Category');
const ApiResponse = require('../utils/apiResponse');
const slugify = require('slugify');
const logger = require('../utils/logger');
const { getIO } = require('../utils/socket');

exports.getCategories = async (req, res, next) => {
  try {
    const { all } = req.query;
    const showAll = all === 'true' || all === true || all === '1';
    const filter = showAll ? {} : { isActive: true };
    
    const categories = await Category.aggregate([
      { $match: filter },
      {
        $lookup: {
          from: 'products',
          localField: '_id',
          foreignField: 'category',
          as: 'products'
        }
      },
      {
        $addFields: {
          productCount: { $size: '$products' }
        }
      },
      {
        $project: {
          products: 0 // Remove the actual products array to keep payload small
        }
      },
      { $sort: { name: 1 } }
    ]);

    return ApiResponse.success(res, { categories });
  } catch (error) { next(error); }
};

exports.getCategory = async (req, res, next) => {
  try {
    const { slug } = req.params;
    const mongoose = require('mongoose');
    
    // Log referer to trace where the stale request is coming from
    logger.info(`[CategoryAudit] GET request for slug/id: ${slug} | Referer: ${req.headers.referer || 'Direct'}`);

    // Defensive: If it looks like a stale ObjectId but doesn't exist
    let category;
    if (mongoose.Types.ObjectId.isValid(slug)) {
      category = await Category.findById(slug);
    } else {
      category = await Category.findOne({ slug, isActive: true });
    }

    if (!category) {
      logger.warn(`[CategoryAudit] 404: Category not found for identifier: ${slug}`);
      return ApiResponse.notFound(res, 'Category not found');
    }

    return ApiResponse.success(res, { category });
  } catch (error) { next(error); }
};

exports.createCategory = async (req, res, next) => {
  try {
    const data = req.body;
    if (!data.slug) data.slug = slugify(data.name, { lower: true, strict: true });
    const category = await Category.create(data);
    return ApiResponse.created(res, { category });
  } catch (error) { next(error); }
};

exports.updateCategory = async (req, res, next) => {
  try {
    const oldCategory = await Category.findById(req.params.id);
    if (!oldCategory) return ApiResponse.notFound(res, 'Category not found');

    const oldImages = new Set([oldCategory.image, oldCategory.tabletImage, oldCategory.mobileImage, oldCategory.sizeChart].filter(Boolean));

    const category = await Category.findByIdAndUpdate(req.params.id, req.body, { new: true });
    
    const newImages = new Set([category.image, category.tabletImage, category.mobileImage, category.sizeChart].filter(Boolean));
    const orphanedImages = [...oldImages].filter(url => !newImages.has(url) && url.includes('res.cloudinary.com'));

    if (orphanedImages.length > 0) {
      const { deleteMultipleCloudinaryAssets } = require('../utils/cloudinaryHelper');
      deleteMultipleCloudinaryAssets(orphanedImages).catch(err => console.error('[Category Orphaned Images Cleanup Failed]', err));
    }
    
    // If name changed, sync with denormalized fields in other collections
    if (req.body.name && req.body.name !== oldCategory.name) {
      const Inventory = require('../models/Inventory');
      const Purchase = require('../models/Purchase');

      await Inventory.updateMany(
        { category: oldCategory.name },
        { $set: { category: category.name } }
      );

      await Purchase.updateMany(
        { 'items.category': oldCategory.name },
        { $set: { 'items.$.category': category.name } }
      );
    }

    return ApiResponse.success(res, { category });
  } catch (error) { next(error); }
};

exports.deleteCategory = async (req, res, next) => {
  try {
    const category = await Category.findById(req.params.id);
    if (!category) return ApiResponse.notFound(res, 'Category not found');
    
    // 1. Cascade Cleanup: Unlink products from this category
    const Product = require('../models/Product');
    const Inventory = require('../models/Inventory');
    
    // Set category to null in Product documents (relational link)
    await Product.updateMany(
      { category: req.params.id }, 
      { $set: { category: null } }
    );
    
    // Set category name to 'Uncategorized' in Inventory documents (cached field)
    // AND update the category ID reference to null if it exists
    await Inventory.updateMany(
      { $or: [{ category: category.name }, { categoryId: req.params.id }] }, 
      { $set: { category: 'Uncategorized', categoryId: null } }
    );

    // 2. Cleanup Purchase records (statically stored category name)
    const Purchase = require('../models/Purchase');
    await Purchase.updateMany(
      { 'items.category': category.name },
      { $set: { 'items.$.category': 'Uncategorized' } }
    );
    
    // 3. Cloudinary cleanup for Category Images
    const imageUrls = [category.image, category.tabletImage, category.mobileImage, category.sizeChart].filter(Boolean);
    if (imageUrls.length > 0) {
      const { deleteCloudinaryAsset } = require('../utils/cloudinaryHelper');
      imageUrls.forEach(url => {
        if (url.includes('res.cloudinary.com')) {
          deleteCloudinaryAsset(url).catch(err => logger.error(`[Category Cloudinary Cleanup] ${err.message}`));
        }
      });
    }

    // 4. Hard delete for taxonomy
    await Category.findByIdAndDelete(req.params.id);
    
    // 🚀 LOGICAL REFLAT: Clear category caches
    getIO().emit('CATEGORY_DELETED', { id: req.params.id, name: category.name });
    
    return ApiResponse.success(res, null, 'Category removed and all related records unlinked/cleaned');
  } catch (error) { 
    next(error); 
  }
};
