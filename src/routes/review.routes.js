const express = require('express');
const r = express.Router();
const c = require('../controllers/review.controller');
const { protect, isAdmin } = require('../middlewares/auth');
const upload = require('../middlewares/upload.middleware');

// Public
r.get('/product/:productId', c.getProductReviews);
r.get('/stats/:productId', c.getReviewStats);

// User
r.post('/create', protect, c.createReview);
r.post('/upload', protect, upload.array('images', 5), (req, res) => {
  if (!req.files) return res.status(400).json({ success: false, message: 'No images uploaded' });
  const urls = req.files.map(file => file.path);
  res.json({ success: true, urls });
});
r.post('/:id/like', protect, c.likeReview);
r.post('/:id/dislike', protect, c.dislikeReview);

// Admin
r.get('/all', protect, isAdmin, c.getAllReviews);
r.put('/:id/status', protect, isAdmin, c.updateReviewStatus);
r.delete('/:id', protect, isAdmin, c.deleteReview);

module.exports = r;
