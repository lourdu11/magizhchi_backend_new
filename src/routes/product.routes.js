const express = require('express');
const r = express.Router();
const c = require('../controllers/product.controller');
const { protect } = require('../middlewares/auth');
const { isAdmin } = require('../middlewares/auth');

r.get('/', c.getProducts);
r.get('/search', c.searchProducts);
r.get('/:slug', c.getProduct);
r.get('/admin/detail/:id', protect, isAdmin, c.getAdminProductById);
r.post('/', protect, isAdmin, c.createProduct);
r.put('/:id', protect, isAdmin, c.updateProduct);
r.delete('/:id', protect, isAdmin, c.deleteProduct);

module.exports = r;
