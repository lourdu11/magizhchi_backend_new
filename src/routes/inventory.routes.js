const express = require('express');
const router = express.Router();
const inventoryCtrl = require('../controllers/inventory.controller');
// Auth is already applied by admin.routes.js — no need to re-apply here

// ── Stats & Lists (MUST come before /:id routes) ─────
router.get('/ping',               (req, res) => res.json({ success: true, message: 'Inventory router reached' }));
router.get('/stats',              inventoryCtrl.getInventoryStats);
router.get('/low-stock',          inventoryCtrl.getLowStock);
router.get('/barcode/:barcode',   inventoryCtrl.getByBarcode);
router.get('/',                   inventoryCtrl.getInventory);
router.post('/',                  inventoryCtrl.createInventoryItem);

// ── Per-item Operations (dynamic :id routes last) ────
router.put('/:id/toggle',         inventoryCtrl.toggleChannel);
router.put('/:id/channel-config',  inventoryCtrl.updateChannelConfig);
router.put('/:id/selling-price',  inventoryCtrl.updateSellingPrice);
router.put('/:id/adjust',         inventoryCtrl.adjustStock);
router.put('/:id/details',        inventoryCtrl.updateInventoryDetails);
router.get('/:id/history',        inventoryCtrl.getStockHistory);
router.put('/:id/link-product',   inventoryCtrl.linkProduct);
router.delete('/:id',             inventoryCtrl.deleteInventoryItem);

module.exports = router;
