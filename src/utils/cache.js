const logger = require('./logger');

let redisClient = null;
const memoryCache = new Map();

// Initialize Redis if configured
if (process.env.REDIS_URL || process.env.REDIS_HOST) {
  try {
    const { createClient } = require('redis');
    const redisUrl = process.env.REDIS_URL || `redis://${process.env.REDIS_HOST || 'localhost'}:${process.env.REDIS_PORT || 6379}`;
    
    redisClient = createClient({ url: redisUrl });
    redisClient.connect()
      .then(() => {
        logger.info('💾 Redis: Distributed caching layer connected successfully.');
      })
      .catch((err) => {
        logger.error('❌ Redis Connection Error for caching layer:', err);
        redisClient = null; // Fall back to memory cache
      });
  } catch (e) {
    logger.warn('💾 Redis Preparation: redis package not installed. Memory-based cache will be used.');
  }
}

module.exports = {
  /**
   * Get value from cache
   * @param {string} key 
   */
  get: async (key) => {
    if (redisClient) {
      try {
        const val = await redisClient.get(key);
        return val ? JSON.parse(val) : null;
      } catch (err) {
        logger.error('Redis cache get error:', err);
      }
    }
    
    // Memory Cache Fallback
    const item = memoryCache.get(key);
    if (!item) return null;
    
    // Check expiration
    if (item.expiresAt && Date.now() > item.expiresAt) {
      memoryCache.delete(key);
      return null;
    }
    
    return item.value;
  },

  /**
   * Set value in cache
   * @param {string} key 
   * @param {any} value 
   * @param {number} ttlInSeconds 
   */
  set: async (key, value, ttlInSeconds = 300) => {
    if (redisClient) {
      try {
        await redisClient.set(key, JSON.stringify(value), {
          EX: ttlInSeconds
        });
        return true;
      } catch (err) {
        logger.error('Redis cache set error:', err);
      }
    }

    // Memory Cache Fallback
    const expiresAt = ttlInSeconds ? Date.now() + (ttlInSeconds * 1000) : null;
    memoryCache.set(key, { value, expiresAt });
    return true;
  },

  /**
   * Delete value from cache
   * @param {string} key 
   */
  del: async (key) => {
    if (redisClient) {
      try {
        await redisClient.del(key);
        return true;
      } catch (err) {
        logger.error('Redis cache del error:', err);
      }
    }

    memoryCache.delete(key);
    return true;
  },

  /**
   * Clear all items in memory cache (or flush redis)
   */
  flush: async () => {
    if (redisClient) {
      try {
        await redisClient.flushAll();
        return true;
      } catch (err) {
        logger.error('Redis cache flush error:', err);
      }
    }

    memoryCache.clear();
    return true;
  }
};
