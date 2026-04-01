module.exports = {
  apps: [{
    name: 'dashboard',
    script: 'server.js',
    env: {
      NODE_ENV: 'production'
    },
    // Auto-restart on crash
    autorestart: true,
    max_restarts: 10,
    min_uptime: '10s',
    // Graceful shutdown
    kill_timeout: 10000,
    listen_timeout: 8000,
    // Logs managed by pino to logs/dashboard.log
    // PM2 logs as backup
    error_file: 'logs/pm2-error.log',
    out_file: 'logs/pm2-out.log',
    merge_logs: true,
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
  }]
};
