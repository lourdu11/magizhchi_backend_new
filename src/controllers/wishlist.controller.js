const Wishlist = require('../models/Wishlist');
const ApiResponse = require('../utils/apiResponse');

exports.getWishlist = async (req, res, next) => {
  try {
    let wishlist = await Wishlist.findOne({ userId: req.user._id })
      .populate('products.productId', 'name slug images sellingPrice discountedPrice isActive ratings');
    if (!wishlist) wishlist = { products: [] };
    return ApiResponse.success(res, { wishlist });
  } catch (error) { next(error); }
};

exports.addToWishlist = async (req, res, next) => {
  try {
    const { productId } = req.body;
    if (!productId) return ApiResponse.error(res, 'Product ID is required', 400);

    let wishlist = await Wishlist.findOne({ userId: req.user._id });
    if (!wishlist) {
      wishlist = await Wishlist.create({ userId: req.user._id, products: [] });
    }

    // Safeguard: Filter out any null productIds and check if exists
    const exists = wishlist.products.some(p => p.productId && p.productId.toString() === productId.toString());
    
    if (!exists) {
      wishlist.products.push({ productId });
      await wishlist.save();
    }

    return ApiResponse.success(res, null, 'Added to wishlist');
  } catch (error) { 
    logger.error(`Wishlist Add Error: ${error.message}`);
    next(error); 
  }
};

exports.removeFromWishlist = async (req, res, next) => {
  try {
    await Wishlist.findOneAndUpdate(
      { userId: req.user._id },
      { $pull: { products: { productId: req.params.productId } } }
    );
    return ApiResponse.success(res, null, 'Removed from wishlist');
  } catch (error) { next(error); }
};
