module.exports = {
  apps: [
    {
      name: 'magizhchi-backend',
      script: './server.js',
      instances: 1,           // WhatsApp and sockets are process-local until Redis is configured
      exec_mode: 'fork',
      autorestart: true,
      watch: false,           // Set to true only in pure dev mode without heavy IO
      max_memory_restart: '1G', // Prevent memory leaks from taking down the server
      env: {
        NODE_ENV: 'development'
      },
      env_production: {
        NODE_ENV: 'production'
      }
    }
  ]
};
