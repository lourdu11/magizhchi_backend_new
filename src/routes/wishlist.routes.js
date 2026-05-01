const express = require('express');
const r = express.Router();
const c = require('../controllers/wishlist.controller');
const { protect } = require('../middlewares/auth');

r.use(protect);
r.get('/', c.getWishlist);
r.post('/add', c.addToWishlist);
r.delete('/remove/:productId', c.removeFromWishlist);

module.exports = r;
