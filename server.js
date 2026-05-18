require('dotenv').config();
const app = require('./app');
const connectDB = require('./src/config/db');
const logger = require('./src/utils/logger');
const dns = require('dns');

// Force IPv4 first to fix Render connection issues with Gmail/SMTP
if (dns.setDefaultResultOrder) {
  dns.setDefaultResultOrder('ipv4first');
}
const fs = require('fs');
const path = require('path');

// Ensure logs directory exists
const logsDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

const http = require('http');
const socketUtil = require('./src/utils/socket');

const PORT = process.env.PORT || 5000;

const startServer = async () => {
  await connectDB();

  const server = http.createServer(app);
  socketUtil.init(server);

  server.listen(PORT, () => {
    logger.info(`🚀 Magizhchi API running on port ${PORT} [${process.env.NODE_ENV}]`);
    logger.info(`📍 Health: http://localhost:${PORT}/api/v1/health`);

    // --- 🛡️ CLUSTER PROTECTION (PM2) ---
    // Only run these singletons on the primary instance (instance 0)
    // If not using PM2 cluster, NODE_APP_INSTANCE is undefined, which is also fine.
    const isPrimaryInstance = !process.env.NODE_APP_INSTANCE || process.env.NODE_APP_INSTANCE === '0';

    if (isPrimaryInstance) {
      // Auto-init WhatsApp so QR appears immediately
      if (process.env.WHATSAPP_AUTO_INIT === 'true') {
        const { initWhatsApp } = require('./src/services/whatsapp.service');
        logger.info('📱 WhatsApp: Starting... Scan QR code when it appears below ↓');
        initWhatsApp();
      }

      // Start Background Tasks (Cron)
      const { initCronJobs } = require('./src/services/cron.service');
      initCronJobs();

      // Self-Healing: Resume interrupted broadcasts
      const { resumeInterruptedBroadcasts } = require('./src/controllers/broadcast.controller');
      resumeInterruptedBroadcasts();
    }

    // Verify Email Configuration (Safe to run on all instances)
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

  process.on('unhandledRejection', (err, promise) => {
    const msg = err?.message || (typeof err === 'object' ? JSON.stringify(err) : String(err));
    logger.error(`🔥 UNHANDLED REJECTION: ${msg}`);
    logger.error(`Promise: ${promise}`);
    // DO NOT exit — a single bad aggregation/request should not kill the entire server.
    // Log it and keep running. Critical errors should use try/catch in controllers.
  });
};

startServer();
