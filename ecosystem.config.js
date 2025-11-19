module.exports = {
  apps: [
    {
      name: 'discord-bot',
      script: 'index.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production'
      }
    },
    {
      name: 'redis',
      script: 'redis-server',
      interpreter: 'none',
      autorestart: true,
      watch: false,
      exec_mode: 'fork'
    }
  ]
};