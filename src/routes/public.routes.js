const express = require('express');
const r = express.Router();
const c = require('../controllers/public.controller');

// Publicly accessible store settings
r.get('/settings', c.getPublicSettings);

// Order tracking for guests (Order ID + Phone)
r.post('/track-order', c.trackOrder);

// Public order details (for post-checkout redirect)
r.get('/order/:id', c.getPublicOrderDetails);

module.exports = r;
