const Banner = require('../models/Banner');
const ApiResponse = require('../utils/apiResponse');

// Get active banners (Public)
exports.getActiveBanners = async (req, res, next) => {
  try {
    const banners = await Banner.find({ isActive: true }).sort('displayOrder');
    return ApiResponse.success(res, banners);
  } catch (error) { next(error); }
};

// Admin: Get all banners
exports.getAllBanners = async (req, res, next) => {
  try {
    const banners = await Banner.find().sort('displayOrder');
    return ApiResponse.success(res, banners);
  } catch (error) { next(error); }
};

// Admin: Create banner
exports.createBanner = async (req, res, next) => {
  try {
    const banner = await Banner.create(req.body);
    return ApiResponse.created(res, banner, 'Banner created successfully');
  } catch (error) { next(error); }
};

// Admin: Delete banner
exports.deleteBanner = async (req, res, next) => {
  try {
    const banner = await Banner.findByIdAndDelete(req.params.id);
    if (!banner) return ApiResponse.notFound(res, 'Banner not found');
    return ApiResponse.success(res, null, 'Banner deleted');
  } catch (error) { next(error); }
};

// Admin: Update banner
exports.updateBanner = async (req, res, next) => {
  try {
    const banner = await Banner.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!banner) return ApiResponse.notFound(res, 'Banner not found');
    return ApiResponse.success(res, banner, 'Banner updated');
  } catch (error) { next(error); }
};
