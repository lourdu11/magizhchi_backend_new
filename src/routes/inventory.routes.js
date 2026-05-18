const express = require('express');
const router = express.Router();
const { isAdmin, isStaff } = require('../middlewares/auth');
const inventoryCtrl = require('../controllers/inventory.controller');

// ── Stats & Lists (MUST come before /:id routes) ─────
router.get('/ping',               (req, res) => res.json({ success: true, message: 'Inventory router reached' }));
router.post('/restore-channels',  isAdmin, inventoryCtrl.restoreAllChannels); // ✅ Admin: fix disabled channels for in-stock items
router.get('/stats',              isStaff, inventoryCtrl.getInventoryStats);
router.get('/low-stock',          isStaff, inventoryCtrl.getLowStock);
router.get('/barcode/:barcode',   isStaff, inventoryCtrl.getByBarcode);
router.get('/all-history',      isAdmin, inventoryCtrl.getAllStockHistory); 
router.post('/reconcile',      isAdmin, require('../controllers/audit.controller').reconcileStock); 
router.post('/sync-all',         isAdmin, inventoryCtrl.syncAllStock);
router.get('/',                   isStaff, inventoryCtrl.getInventory);
router.post('/',                  isAdmin, inventoryCtrl.createInventoryItem);

// ── Per-item Operations (dynamic :id routes last) ────
router.put('/:id/toggle',         isAdmin, inventoryCtrl.toggleChannel);
router.put('/:id/channel-config',  isAdmin, inventoryCtrl.updateChannelConfig);
router.put('/:id/selling-price',  isAdmin, inventoryCtrl.updateSellingPrice);
router.put('/:id/adjust',         isStaff, inventoryCtrl.adjustStock); // Staff can record returns/wastage
router.put('/:id/details',        isAdmin, inventoryCtrl.updateInventoryDetails);
router.get('/:id/history',        isStaff, inventoryCtrl.getStockHistory);
router.put('/:id/link-product',   isAdmin, inventoryCtrl.linkProduct);
router.delete('/:id',             isAdmin, inventoryCtrl.deleteInventoryItem);

module.exports = router;
