import 'dotenv/config';
import { runSync } from './sync.js';
import logger from './logger.js';

// Run a single sync cycle and exit.
// Usage: npm run sync:once

logger.info('Running one-time sync...');

try {
  await runSync();
} catch (err) {
  logger.error('Sync failed', { error: err.message, stack: err.stack });
  process.exit(1);
}

logger.info('Done.');
process.exit(0);
