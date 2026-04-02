import 'dotenv/config';
import cron from 'node-cron';
import { runSync } from './sync.js';
import logger from './logger.js';

// ─── Validate required env vars ────────────────────────────────

const required = [
  'IMPACT_PUBLIC_API_KEY',
  'IMPACT_PRIVATE_API_KEY',
  'IMPACT_USER_TOKEN',
  'IMPACT_ORG_ID',
  'DRCHRONO_CLIENT_ID',
  'DRCHRONO_CLIENT_SECRET',
  'DRCHRONO_ACCESS_TOKEN',
  'DRCHRONO_REFRESH_TOKEN',
];

const missing = required.filter(k => !process.env[k]);
if (missing.length) {
  logger.error(`Missing required env vars: ${missing.join(', ')}`);
  logger.error('Copy .env.example to .env and fill in your credentials');
  process.exit(1);
}

// ─── Schedule ──────────────────────────────────────────────────

const schedule = process.env.SYNC_CRON || '*/15 * * * *';

logger.info('ImPACT → DrChrono sync service starting');
logger.info(`Schedule: ${schedule}`);
logger.info(`Lookback: ${process.env.LOOKBACK_HOURS || 24} hours`);

// Run once immediately on startup
runSync().catch(err => logger.error('Initial sync failed', { error: err.message }));

// Then run on schedule
cron.schedule(schedule, () => {
  runSync().catch(err => logger.error('Scheduled sync failed', { error: err.message }));
});

// ─── Graceful shutdown ─────────────────────────────────────────

process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down');
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down');
  process.exit(0);
});
