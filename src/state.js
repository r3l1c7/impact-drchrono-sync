import fs from 'fs';
import path from 'path';
import logger from './logger.js';

const STATE_FILE = './data/sync-state.json';

function ensureDir() {
  const dir = path.dirname(STATE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export function loadState() {
  ensureDir();
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
  } catch (err) {
    logger.warn('Could not read state file, starting fresh', { error: err.message });
  }
  return { processedTestIDs: [], lastSync: null };
}

export function saveState(state) {
  ensureDir();
  state.lastSync = new Date().toISOString();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

export function isProcessed(state, testID) {
  return state.processedTestIDs.includes(String(testID));
}

export function markProcessed(state, testID) {
  state.processedTestIDs.push(String(testID));
  // Keep only the last 10,000 IDs
  if (state.processedTestIDs.length > 10000) {
    state.processedTestIDs = state.processedTestIDs.slice(-10000);
  }
  saveState(state);
}
