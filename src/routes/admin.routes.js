const express = require('express');
const r = express.Router();
const c = require('../controllers/admin.controller');
const publicController = require('../controllers/public.controller');
const productController = require('../controllers/product.controller');
const { protect, isAdmin, isStaff, authorize } = require('../middlewares/auth');

r.use(protect); // All admin routes require login

r.get('/dashboard', isAdmin, c.getDashboardStats);
r.get('/health', authorize('admin', 'staff'), c.getServiceHealth);
r.get('/analytics/sales', isAdmin, c.getSalesAnalytics);
const reportController = require('../controllers/report.controller');
r.get('/reports/daily', isStaff, reportController.getDailyProfitReport);
r.get('/staff/performance', isAdmin, c.getStaffPerformance);
r.get('/users', isStaff, c.getAllUsers);
r.put('/users/:id/toggle-block', isAdmin, c.toggleBlockUser);
r.delete('/users/:id', isAdmin, c.deleteUser);
r.post('/users', isStaff, c.createCustomer);
r.get('/staff', isAdmin, c.getStaff);
r.get('/staff-list', isStaff, publicController.getStaffList);
r.post('/staff', isAdmin, c.createStaff);
r.put('/staff/:id', isAdmin, c.updateStaff);
r.delete('/staff/:id', isAdmin, c.deleteStaff);
r.get('/products', isStaff, productController.getAdminProducts);
r.post('/products/:id/restore', isAdmin, productController.restoreProduct);
r.post('/inventory/audit', isAdmin, c.runInventoryAudit);

// ── Media Management ──
r.delete('/media', isAdmin, c.deleteCloudinaryMedia);

// ─── Procurement & Supply Chain (VIP) ───────────────────────
const purchaseController = require('../controllers/purchase.controller');

r.get('/purchases', isStaff, purchaseController.getPurchases);
r.post('/purchases', isStaff, purchaseController.createPurchase);
r.put('/purchases/:id', isAdmin, purchaseController.updatePurchase);
r.post('/purchases/:id/restore', isAdmin, purchaseController.restorePurchase);
r.post('/purchases/:id/resync', isAdmin, purchaseController.resyncPurchase);
r.delete('/purchases/:id', isAdmin, purchaseController.deletePurchase);
r.get('/suppliers', isStaff, purchaseController.getSuppliers);
r.post('/suppliers', isAdmin, purchaseController.createSupplier);
r.put('/suppliers/:id', isAdmin, purchaseController.updateSupplier);
r.put('/suppliers/:id/record-payment', isAdmin, purchaseController.recordPayment);
r.put('/suppliers/:supplierId/payments/:paymentId', isAdmin, purchaseController.updatePayment);
r.delete('/suppliers/:supplierId/payments/:paymentId', isAdmin, purchaseController.deletePayment);
r.post('/suppliers/:id/restore', isAdmin, purchaseController.restoreSupplier);
r.delete('/suppliers/:id', isAdmin, purchaseController.deleteSupplier);

// Returns & Exchanges
const returnController = require('../controllers/return.controller');
r.get('/returns', isStaff, returnController.getReturns);
r.post('/returns', isStaff, returnController.createReturn);

// Wastage & Damages
const wastageController = require('../controllers/wastage.controller');
r.get('/wastage', isStaff, wastageController.getWastageHistory);
r.post('/wastage', isStaff, wastageController.createWastage);

// Settings & Config
r.get('/settings', isStaff, c.getSettings);
r.put('/settings', isAdmin, c.updateSettings);
r.post('/test-notifications-v2', isAdmin, c.testNotifications);
r.post('/reset-system-data', isAdmin, c.resetSystemData);

// ── Data Reset Safety Routes ──
const backupController = require('../controllers/backup.controller');
r.get('/system-backups', isAdmin, backupController.getAvailableRestores);
r.post('/restore-system-data', isAdmin, backupController.restoreLastReset);
r.get('/sync-integrity', isAdmin, c.getSyncIntegrityStats);

// ─── Broadcast Center ─────────────────────────────────────────
const broadcastController = require('../controllers/broadcast.controller');
r.get('/broadcast/customers', isAdmin, broadcastController.getBroadcastCustomers);
r.post('/broadcast/send', isAdmin, broadcastController.createBroadcast);
r.get('/broadcast/history', isAdmin, broadcastController.getBroadcastHistory);
r.get('/broadcast/details/:id', isAdmin, broadcastController.getBroadcastDetails);
r.post('/broadcast/whatsapp/disconnect', isAdmin, broadcastController.disconnectWhatsApp);

// Templates
r.get('/broadcast/templates', isAdmin, broadcastController.getTemplates);
r.post('/broadcast/templates', isAdmin, broadcastController.createTemplate);
r.put('/broadcast/templates/:id', isAdmin, broadcastController.updateTemplate);
r.delete('/broadcast/templates/:id', isAdmin, broadcastController.deleteTemplate);

module.exports = r;
