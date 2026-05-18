const mongoose = require('mongoose');
const logger = require('../utils/logger');

const connectDB = async (retryCount = 0) => {
  const MAX_RETRIES = 5;
  try {
    let uri = process.env.MONGODB_URI;
    const isLocal = uri.includes('localhost') || uri.includes('127.0.0.1');

    const options = {
      serverSelectionTimeoutMS: 30000, // 30s for stability
      socketTimeoutMS: 60000,         // 60s for heavy aggregations
      maxPoolSize: 50,                // Higher concurrency
      minPoolSize: 5,                 // Keep some connections alive
      heartbeatFrequencyMS: 2000,     // Detect disconnects faster
    };

    if (!isLocal) {
      options.retryWrites = true;
      options.w = 'majority';
    }

    const conn = await mongoose.connect(uri, options);
    logger.info(`✅ MongoDB Connected: ${conn.connection.host}`);
  } catch (error) {
    logger.error(`❌ MongoDB Connection Error (Attempt ${retryCount + 1}): ${error.message}`);
    
    // Help the user identify their IP for whitelisting
    if (retryCount === 0) {
      try {
        const axios = require('axios');
        const response = await axios.get('https://api.ipify.org?format=json');
        logger.info(`💡 Your Public IP: ${response.data.ip}`);
        logger.info(`👉 Add this IP to your Atlas Whitelist: https://cloud.mongodb.com`);
      } catch (ipErr) { /* ignore */ }
    }

    if (retryCount < MAX_RETRIES) {
      const delay = Math.pow(2, retryCount) * 1000;
      logger.info(`🔄 Retrying in ${delay/1000}s...`);
      setTimeout(() => connectDB(retryCount + 1), delay);
    } else {
      logger.error('🔥 CRITICAL: Max MongoDB connection retries reached. Exiting.');
      process.exit(1);
    }
  }
};

mongoose.connection.on('disconnected', () => {
  logger.warn('⚠️ MongoDB disconnected. Attempting to reconnect...');
});

mongoose.connection.on('reconnected', () => {
  logger.info('✅ MongoDB reconnected successfully');
});

module.exports = connectDB;
