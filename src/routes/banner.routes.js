const express = require('express');
const r = express.Router();
const c = require('../controllers/banner.controller');
const { protect, isAdmin } = require('../middlewares/auth');

// Public
r.get('/active', c.getActiveBanners);

// Admin
r.get('/all', protect, isAdmin, c.getAllBanners);
r.post('/create', protect, isAdmin, c.createBanner);
r.put('/:id', protect, isAdmin, c.updateBanner);
r.delete('/:id', protect, isAdmin, c.deleteBanner);

module.exports = r;
