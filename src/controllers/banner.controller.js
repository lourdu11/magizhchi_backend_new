const Banner = require('../models/Banner');
const ApiResponse = require('../utils/apiResponse');
const { deleteFile } = require('../utils/fileHelper');

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
    
    // Delete images from Cloudinary or local disk
    const imagesToClean = [banner.desktopImage, banner.mobileImage].filter(Boolean);
    if (imagesToClean.length > 0) {
      const { deleteCloudinaryAsset } = require('../utils/cloudinaryHelper');
      imagesToClean.forEach(url => {
        if (url.includes('res.cloudinary.com')) {
          deleteCloudinaryAsset(url).catch(err => 
             console.error('Failed to delete banner image from Cloudinary:', err)
          );
        } else {
          deleteFile(url);
        }
      });
    }

    return ApiResponse.success(res, null, 'Banner deleted');
  } catch (error) { next(error); }
};

// Admin: Update banner
exports.updateBanner = async (req, res, next) => {
  try {
    const oldBanner = await Banner.findById(req.params.id);
    if (!oldBanner) return ApiResponse.notFound(res, 'Banner not found');

    const banner = await Banner.findByIdAndUpdate(req.params.id, req.body, { new: true });
    
    // Cleanup orphaned Cloudinary images if they were replaced
    const oldImages = [oldBanner.desktopImage, oldBanner.mobileImage].filter(Boolean);
    const newImages = new Set([banner.desktopImage, banner.mobileImage].filter(Boolean));
    const orphanedImages = oldImages.filter(url => !newImages.has(url) && url.includes('res.cloudinary.com'));

    if (orphanedImages.length > 0) {
      const { deleteMultipleCloudinaryAssets } = require('../utils/cloudinaryHelper');
      deleteMultipleCloudinaryAssets(orphanedImages).catch(err => 
        console.error('[Banner Orphaned Image Cleanup Failed]', err)
      );
    }

    return ApiResponse.success(res, banner, 'Banner updated');
  } catch (error) { next(error); }
};
