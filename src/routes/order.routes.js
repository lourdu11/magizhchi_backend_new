const express = require('express');
const r = express.Router();
const orderController = require('../controllers/order.controller');
const adminController = require('../controllers/admin.controller');
const { protect, isAdmin, isStaff } = require('../middlewares/auth');
const { optionalAuth } = require('../middlewares/auth');

r.post('/create', optionalAuth, orderController.createOrder);
r.post('/verify-payment', optionalAuth, orderController.verifyPayment);
r.get('/my-orders', protect, orderController.getUserOrders);
r.get('/all', protect, isStaff, orderController.getAllOrders);
r.get('/:id', protect, orderController.getOrder);
r.post('/:id/cancel', protect, orderController.cancelOrder);
r.post('/:id/return', protect, orderController.requestReturn);
r.put('/:id/status', protect, isStaff, orderController.updateOrderStatus);
r.post('/:id/resend-receipt', protect, isStaff, orderController.resendReceipt);
r.put('/:id/return-status', protect, isStaff, orderController.updateReturnStatus);
r.post('/:id/retry-payment', optionalAuth, orderController.retryPayment);
r.post('/:id/payment-abandoned', optionalAuth, orderController.abandonPayment);

module.exports = r;
