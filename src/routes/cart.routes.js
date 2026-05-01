const express = require('express');
const r = express.Router();
const c = require('../controllers/cart.controller');
const { protect } = require('../middlewares/auth');

r.use(protect);
r.get('/', c.getCart);
r.post('/add', c.addToCart);
r.put('/update/:itemId', c.updateCartItem);
r.delete('/remove/:itemId', c.removeFromCart);
r.delete('/clear', c.clearCart);

module.exports = r;
