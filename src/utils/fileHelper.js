const fs = require('fs');
const path = require('path');
const logger = require('./logger');

/**
 * Delete a file from the uploads directory
 * @param {string} fileUrl - The full URL or relative path of the file
 */
const deleteFile = (fileUrl) => {
  if (!fileUrl) return;

  try {
    // Extract filename from URL (handles http://localhost:5000/uploads/file.jpg or /uploads/file.jpg)
    const fileName = fileUrl.split('/').pop();
    const filePath = path.join(__dirname, '../uploads', fileName);

    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      logger.info(`🗑️ Deleted orphaned file: ${fileName}`);
    } else {
      logger.warn(`⚠️ File not found for deletion: ${fileName}`);
    }
  } catch (error) {
    logger.error(`❌ Error deleting file: ${error.message}`);
  }
};

module.exports = { deleteFile };
