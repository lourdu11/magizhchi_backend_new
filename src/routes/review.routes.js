const express = require('express');
const r = express.Router();
const c = require('../controllers/review.controller');
const { protect, isAdmin } = require('../middlewares/auth');
const { upload, validateMimeType, uploadToCloudinary } = require('../middlewares/upload.middleware');
const { uploadLimiter } = require('../middlewares/rateLimiter');

// Public
r.get('/product/:productId', c.getProductReviews);
r.get('/stats/:productId', c.getReviewStats);

// User
r.post('/create', protect, c.createReview);
r.post('/upload', protect, uploadLimiter, upload.array('images', 5), validateMimeType, async (req, res) => {
  if (!req.files || req.files.length === 0) return res.status(400).json({ success: false, message: 'No images uploaded' });
  
  try {
    const uploadPromises = req.files.map(file => uploadToCloudinary(file.buffer, 'magizhchi/reviews'));
    const results = await Promise.all(uploadPromises);
    const urls = results.map(r => r.secure_url);
    res.json({ success: true, urls });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});
r.post('/:id/like', protect, c.likeReview);
r.post('/:id/dislike', protect, c.dislikeReview);

// Admin
r.get('/all', protect, isAdmin, c.getAllReviews);
r.put('/:id/status', protect, isAdmin, c.updateReviewStatus);
r.delete('/:id', protect, isAdmin, c.deleteReview);

module.exports = r;
