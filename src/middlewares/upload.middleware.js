const multer = require('multer');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const cloudinary = require('../config/cloudinary');

const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: async (req, file) => {
    const isPdf = file.mimetype === 'application/pdf' || file.originalname.toLowerCase().endsWith('.pdf');
    return {
      folder: 'magizhchi/products',
      allowed_formats: ['jpg', 'jpeg', 'png', 'webp', 'pdf', 'gif', 'heic'],
      resource_type: isPdf ? 'raw' : 'image',
      transformation: isPdf ? [] : [
        { width: 1200, height: 1200, crop: 'limit' },
        { fetch_format: 'auto', quality: 'auto' }
      ]
    };
  },
});

const upload = multer({ 
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB limit
});

module.exports = upload;
