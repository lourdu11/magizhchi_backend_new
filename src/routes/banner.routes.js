const express = require('express');
const r = express.Router();
const c = require('../controllers/banner.controller');
const { protect, requirePermission } = require('../middlewares/auth');

// Public
r.get('/active', c.getActiveBanners);

// Admin / Authorized Staff
r.get('/all', protect, requirePermission('banners'), c.getAllBanners);
r.post('/create', protect, requirePermission('banners'), c.createBanner);
r.put('/:id', protect, requirePermission('banners'), c.updateBanner);
r.delete('/:id', protect, requirePermission('banners'), c.deleteBanner);

module.exports = r;
