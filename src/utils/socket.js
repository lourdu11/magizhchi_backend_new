let io;

module.exports = {
  init: (server) => {
    const { Server } = require('socket.io');
    io = new Server(server, {
      cors: {
        origin: process.env.FRONTEND_URL || '*',
        methods: ['GET', 'POST']
      }
    });

    // ─── REDIS ADAPTER FOR PM2 CLUSTERING ───
    if (process.env.REDIS_URL || process.env.REDIS_HOST) {
      try {
        const { createClient } = require('redis');
        const { createAdapter } = require('@socket.io/redis-adapter');
        const logger = require('./logger');

        const redisUrl = process.env.REDIS_URL || `redis://${process.env.REDIS_HOST || 'localhost'}:${process.env.REDIS_PORT || 6379}`;
        const pubClient = createClient({ url: redisUrl });
        const subClient = pubClient.duplicate();

        Promise.all([pubClient.connect(), subClient.connect()])
          .then(() => {
            io.adapter(createAdapter(pubClient, subClient));
            logger.info('🔌 Redis: Connected and bound Socket.io adapter successfully for PM2 multi-instance scaling.');
          })
          .catch((err) => {
            logger.error('❌ Redis Connection Error for socket.io-adapter:', err);
          });
      } catch (e) {
        const logger = require('./logger');
        logger.warn('🔌 Redis Preparation: redis or @socket.io/redis-adapter package not installed. Falling back to local socket memory adapter.');
      }
    }

    return io;
  },
  getIO: () => {
    if (!io) {
      // Return a dummy object if IO is not initialized to prevent crashes
      return {
        emit: () => {},
        on: () => {}
      };
    }
    return io;
  }
};
