const cloudinary = require('../config/cloudinary');
const logger = require('./logger');

/**
 * Extract the Cloudinary publicId from a secure URL
 * Handles nested folders and version prefixes safely.
 * @param {string} imageUrl 
 * @returns {string|null} publicId
 */
const extractPublicId = (imageUrl) => {
  if (!imageUrl || typeof imageUrl !== 'string' || !imageUrl.includes('res.cloudinary.com')) {
    return null;
  }

  try {
    const parts = imageUrl.split('/upload/');
    if (parts.length < 2) return null;

    // Remaining part: "v12345678/folder/subfolder/file.png" or "folder/file.jpg"
    let pathPart = parts[1];
    const pathSegments = pathPart.split('/');

    // Check if the first segment is a version identifier (e.g., "v1234567")
    if (pathSegments[0].startsWith('v') && /^\d+$/.test(pathSegments[0].substring(1))) {
      pathSegments.shift(); // Remove the version prefix
    }

    // Join remaining segments back together
    const fullPathWithExt = pathSegments.join('/');

    // Strip file extension from the end
    const lastDotIndex = fullPathWithExt.lastIndexOf('.');
    if (lastDotIndex === -1) return fullPathWithExt;

    return fullPathWithExt.substring(0, lastDotIndex);
  } catch (error) {
    logger.error(`❌ Error extracting public ID from Cloudinary URL: ${error.message}`);
    return null;
  }
};

/**
 * Permanently delete a single asset from Cloudinary
 * @param {string} imageUrl 
 * @returns {Promise<boolean>}
 */
const deleteCloudinaryAsset = async (imageUrl) => {
  if (!imageUrl) return false;

  const publicId = extractPublicId(imageUrl);
  if (!publicId) {
    logger.warn(`⚠️ Cloudinary publicId could not be extracted for: ${imageUrl}`);
    return false;
  }

  try {
    const result = await cloudinary.uploader.destroy(publicId);
    if (result.result === 'ok') {
      logger.info(`🗑️ Deleted Cloudinary asset: ${publicId}`);
      return true;
    } else {
      logger.warn(`⚠️ Cloudinary destroy returned status: ${result.result} for ${publicId}`);
      return false;
    }
  } catch (error) {
    logger.error(`❌ Failed to delete Cloudinary asset: ${imageUrl} | Error: ${error.message}`);
    return false;
  }
};

/**
 * Permanently delete multiple assets from Cloudinary
 * @param {string[]} imageUrls 
 * @returns {Promise<boolean[]>}
 */
const deleteMultipleCloudinaryAssets = async (imageUrls) => {
  if (!imageUrls || !Array.isArray(imageUrls)) return [];
  
  return Promise.all(imageUrls.map(url => deleteCloudinaryAsset(url)));
};

module.exports = {
  extractPublicId,
  deleteCloudinaryAsset,
  deleteMultipleCloudinaryAssets
};
