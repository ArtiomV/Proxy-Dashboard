const pino = require('pino');
const path = require('path');
const fs = require('fs');

const LOG_DIR = path.join(__dirname, '..', 'logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

const logFile = path.join(LOG_DIR, 'dashboard.log');

// Always log to file (append mode) + pretty console in dev
const streams = [
  { stream: fs.createWriteStream(logFile, { flags: 'a' }) },
];
if (process.env.NODE_ENV !== 'production') {
  streams.push({ stream: process.stdout });
}

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  timestamp: pino.stdTimeFunctions.isoTime,
}, pino.multistream(streams));

module.exports = logger;
