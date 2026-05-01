const express = require('express');
const router = express.Router();
const paymentController = require('../controllers/payment.controller');

// Razorpay Webhook - PUBLIC (Signature verified in controller)
// This route is called directly by Razorpay servers
router.post('/webhook', paymentController.handleWebhook);

module.exports = router;
