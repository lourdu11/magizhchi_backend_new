const mongoose = require('mongoose');
const logger = require('../utils/logger');

const connectDB = async () => {
  try {
    const conn = await mongoose.connect(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 10000, // Increased timeout
      socketTimeoutMS: 45000,
      maxPoolSize: 20,
    });
    logger.info(`MongoDB Connected: ${conn.connection.host}`);
  } catch (error) {
    logger.error(`❌ MongoDB Connection Error: ${error.message}`);
    
    // Help the user identify their IP for whitelisting
    try {
      const axios = require('axios');
      const response = await axios.get('https://api.ipify.org?format=json');
      logger.info(`💡 Your Public IP: ${response.data.ip}`);
      logger.info(`👉 Add this IP to your Atlas Whitelist: https://cloud.mongodb.com`);
    } catch (ipErr) {
      // Ignore IP fetch errors
    }
    
    process.exit(1);
  }
};

mongoose.connection.on('disconnected', () => {
  logger.warn('MongoDB disconnected. Attempting to reconnect...');
});

mongoose.connection.on('reconnected', () => {
  logger.info('MongoDB reconnected successfully');
});

module.exports = connectDB;
