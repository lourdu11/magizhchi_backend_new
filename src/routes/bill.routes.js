const express = require('express');
const r = express.Router();
const c = require('../controllers/bill.controller');
const { protect, isAdmin, isStaff, canViewBills, canAdminister } = require('../middlewares/auth');

r.post('/create', protect, isStaff, c.createBill);
r.get('/', protect, canViewBills, c.getBills); 
r.get('/analytics', protect, canViewBills, c.getBillsAnalytics);
r.get('/daily-report', protect, canAdminister, c.getDailyReport); 
r.get('/staff-stats', protect, isStaff, c.getStaffDailyStats);
r.get('/customer/:phone', protect, isStaff, c.lookupCustomer);
r.get('/barcode/:barcode', protect, isStaff, require('../controllers/inventory.controller').getByBarcode);
r.get('/:id', protect, canViewBills, c.getBill); 
r.put('/:id', protect, isStaff, c.updateBill);
r.post('/:id/resend-receipt', protect, isStaff, c.resendReceipt); // ✅ BUG 8 FIX: Was missing
r.delete('/:id', protect, canAdminister, c.deleteBill);  // Admin only — reverses stock
r.post('/:id/refund', protect, canAdminister, c.refundBill); // Process full or partial refund


module.exports = r;
