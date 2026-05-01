const express = require('express');
const router = express.Router();
const purchaseController = require('../controllers/purchase.controller');
const { protect, isAdmin } = require('../middlewares/auth');

// ─── Procurement & Supplier Management ───────────────────
// All purchase routes are protected and admin only
router.use(protect, isAdmin);

router.post('/', purchaseController.createPurchase);
router.get('/', purchaseController.getPurchases);
router.get('/suppliers', purchaseController.getSuppliers);
router.post('/suppliers', purchaseController.createSupplier);

module.exports = router;
