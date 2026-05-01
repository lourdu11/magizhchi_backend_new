const express = require('express');
const r = express.Router();
const c = require('../controllers/admin.controller');
const productController = require('../controllers/product.controller');
const { protect, isAdmin } = require('../middlewares/auth');

r.use(protect, isAdmin);

r.get('/dashboard', c.getDashboardStats);
r.get('/analytics/sales', c.getSalesAnalytics);
r.get('/inventory/all-history', require('../controllers/inventory.controller').getAllStockHistory);
const reportController = require('../controllers/report.controller');
r.get('/reports/daily', reportController.getDailyProfitReport);
r.get('/staff/performance', c.getStaffPerformance);
r.get('/users', c.getAllUsers);
r.put('/users/:id/toggle-block', c.toggleBlockUser);
r.get('/staff', c.getStaff);
r.post('/staff', c.createStaff);
r.put('/staff/:id', c.updateStaff);
r.delete('/staff/:id', c.deleteStaff);
r.get('/products', productController.getAdminProducts);

// ─── Procurement & Supply Chain (VIP) ───────────────────────
const purchaseController = require('../controllers/purchase.controller');

r.get('/purchases', purchaseController.getPurchases);
r.post('/purchases', purchaseController.createPurchase);
r.put('/purchases/:id', purchaseController.updatePurchase);
r.delete('/purchases/:id', purchaseController.deletePurchase);
r.get('/suppliers', purchaseController.getSuppliers);
r.post('/suppliers', purchaseController.createSupplier);
r.put('/suppliers/:id', purchaseController.updateSupplier);
r.put('/suppliers/:id/record-payment', purchaseController.recordPayment);
r.put('/suppliers/:supplierId/payments/:paymentId', purchaseController.updatePayment);
r.delete('/suppliers/:supplierId/payments/:paymentId', purchaseController.deletePayment);
r.delete('/suppliers/:id', purchaseController.deleteSupplier);

// Returns & Exchanges
const returnController = require('../controllers/return.controller');
r.get('/returns', returnController.getReturns);
r.post('/returns', returnController.createReturn);

// Wastage & Damages
const wastageController = require('../controllers/wastage.controller');
r.get('/wastage', wastageController.getWastageHistory);
r.post('/wastage', wastageController.createWastage);

// Stock Audit & Reconciliation
const auditController = require('../controllers/audit.controller');
r.post('/inventory/reconcile', auditController.reconcileStock);

// Settings & Config
r.get('/settings', c.getSettings);
r.put('/settings', c.updateSettings);

module.exports = r;
