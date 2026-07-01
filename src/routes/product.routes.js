const express = require('express');
const r = express.Router();
const c = require('../controllers/product.controller');
const { protect } = require('../middlewares/auth');
const { isAdmin, requirePermission } = require('../middlewares/auth');

r.get('/', c.getProducts);
r.get('/search', c.searchProducts);
r.get('/barcode/:code', protect, c.getProductByBarcode); // 🔍 POS Barcode Lookup (Retsol LS)
r.get('/:slug', c.getProduct);
r.get('/admin/detail/:id', protect, requirePermission('profiles'), c.getAdminProductById);
r.post('/', protect, requirePermission('profiles'), c.createProduct);
r.post('/with-procurement', protect, requirePermission('profiles'), c.createProductWithProcurement);
r.put('/:id', protect, requirePermission('profiles'), c.updateProduct);
r.delete('/:id', protect, requirePermission('profiles'), c.deleteProduct);
r.delete('/admin/purge/:id', protect, requirePermission('profiles'), c.purgeProduct);
r.get('/pos/:productId/variants', protect, c.getPOSProductVariants);

module.exports = r;
