const express = require('express');
const r = express.Router();
const c = require('../controllers/bill.controller');
const { protect, isAdmin, isStaff } = require('../middlewares/auth');

r.post('/create', protect, isStaff, c.createBill);
r.get('/', protect, c.getBills);
r.get('/daily-report', protect, c.getDailyReport);
r.get('/customer/:phone', protect, isStaff, c.lookupCustomer);
r.get('/barcode/:barcode', protect, isStaff, require('../controllers/inventory.controller').getByBarcode);
r.get('/:id', protect, c.getBill);
r.delete('/:id', protect, isAdmin, c.deleteBill);  // Admin only — reverses stock


module.exports = r;
