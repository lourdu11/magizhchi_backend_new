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
