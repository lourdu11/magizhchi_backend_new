module.exports = {
  apps: [
    {
      name: 'magizhchi-backend',
      script: './server.js',
      instances: 'max',       // Utilize all available CPU cores
      exec_mode: 'cluster',   // Enable PM2 cluster mode
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
