const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');

router.post('/test-force', async (req, res) => {
  try {
    logger.info('🚀 Manual test-force route triggered');
    // Simulate a test order notification
    const testPayload = {
      orderId: 'TEST-' + Date.now(),
      status: 'placed',
      message: 'Test order notification triggered',
      timestamp: new Date().toISOString(),
      version: 'V4-USER-REQUESTED'
    };

    res.status(200).json({ success: true, data: testPayload });
  } catch (error) {
    logger.error('❌ test-force error:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
