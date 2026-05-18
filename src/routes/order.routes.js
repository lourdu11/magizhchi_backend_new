const express = require('express');
const r = express.Router();
const orderController = require('../controllers/order.controller');
const adminController = require('../controllers/admin.controller');
const { protect, isAdmin } = require('../middlewares/auth');
const { optionalAuth } = require('../middlewares/auth');

r.post('/create', optionalAuth, orderController.createOrder);
r.post('/reserve', optionalAuth, orderController.reserveStock);
r.post('/verify-payment', optionalAuth, orderController.verifyPayment);
r.get('/my-orders', protect, orderController.getUserOrders);
r.get('/all', protect, isAdmin, orderController.getAllOrders);
r.get('/:id', protect, orderController.getOrder);
r.post('/:id/cancel', protect, orderController.cancelOrder);
r.post('/:id/return', protect, orderController.requestReturn);
r.put('/:id/status', protect, isAdmin, orderController.updateOrderStatus);
r.post('/:id/resend-receipt', protect, isAdmin, orderController.resendReceipt);
r.put('/:id/return-status', protect, isAdmin, orderController.updateReturnStatus);

module.exports = r;
