const multer = require('multer');
const { fileTypeFromBuffer } = require('file-type');
const cloudinary = require('../config/cloudinary');

const ALLOWED_MIME_TYPES = [
  'image/jpeg',
  'image/png', 
  'image/webp',
  'application/pdf'
];

const storage = multer.memoryStorage();

const upload = multer({ 
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB limit
});

const validateMimeType = async (req, res, next) => {
  if (!req.file && !req.files) return next();

  const files = req.file ? [req.file] : req.files;
  
  try {
    for (const file of files) {
      const type = await fileTypeFromBuffer(file.buffer);
      if (!type || !ALLOWED_MIME_TYPES.includes(type.mime)) {
        return res.status(400).json({ 
          success: false, 
          message: `File type not allowed: ${type?.mime || 'unknown'}` 
        });
      }
    }
    next();
  } catch (err) {
    next(err);
  }
};

const uploadToCloudinary = (fileBuffer, folder = 'magizhchi/products') => {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      { folder },
      (error, result) => {
        if (error) reject(error);
        else resolve(result);
      }
    );
    uploadStream.end(fileBuffer);
  });
};

module.exports = { upload, validateMimeType, uploadToCloudinary };
