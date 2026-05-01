const express = require('express');
const r = express.Router();
const c = require('../controllers/coupon.controller');
const { protect, isAdmin } = require('../middlewares/auth');

// Public/User routes
r.post('/validate', c.validateCoupon);

// Admin routes
r.get('/all', protect, isAdmin, c.getAllCoupons);
r.post('/create', protect, isAdmin, c.createCoupon);
r.delete('/:id', protect, isAdmin, c.deleteCoupon);

module.exports = r;
