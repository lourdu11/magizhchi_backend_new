require('dotenv').config();
const app = require('./app');
const connectDB = require('./src/config/db');
const logger = require('./src/utils/logger');
const fs = require('fs');
const path = require('path');

// Ensure logs directory exists
const logsDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

const PORT = process.env.PORT || 5000;

const startServer = async () => {
  await connectDB();

  const server = app.listen(PORT, () => {
    logger.info(`🚀 Magizhchi API running on port ${PORT} [${process.env.NODE_ENV}]`);
    logger.info(`📍 Health: http://localhost:${PORT}/api/v1/health`);

    // Auto-init WhatsApp so QR appears immediately
    if (process.env.WHATSAPP_AUTO_INIT === 'true') {
      const { initWhatsApp } = require('./src/services/whatsapp.service');
      logger.info('📱 WhatsApp: Starting... Scan QR code when it appears below ↓');
      initWhatsApp();
    }

    // Verify Email Configuration
    const { verifyEmailConfig } = require('./src/config/email');
    verifyEmailConfig();
  });


  // Graceful shutdown
  const gracefulShutdown = async (signal) => {
    logger.info(`${signal} received. Shutting down gracefully...`);
    
    // Close WhatsApp if active
    const { closeWhatsApp } = require('./src/services/whatsapp.service');
    await closeWhatsApp();

    server.close(() => {
      logger.info('HTTP server closed.');
      process.exit(0);
    });
  };

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  process.on('unhandledRejection', (err) => {
    logger.error(`Unhandled Rejection: ${err.message}`);
    server.close(() => process.exit(1));
  });
};

startServer();
