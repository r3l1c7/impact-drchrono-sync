import 'dotenv/config';
import { fetchTests, downloadReportPDF } from './impact-client.js';
import { findPatient, uploadDocument, loadTokens } from './drchrono-client.js';
import { loadState, isProcessed, markProcessed } from './state.js';
import logger from './logger.js';

// Test the sync with a wider window to verify cutoff & dedup logic

loadTokens();
const state = loadState();
const CUTOFF_DATE = process.env.SYNC_CUTOFF_DATE || '2026-04-01';
const cutoff = new Date(CUTOFF_DATE);

console.log(`\nCutoff date: ${CUTOFF_DATE}`);
console.log(`State has ${state.processedTestIDs.length} processed test(s): ${state.processedTestIDs.join(', ')}`);

// Fetch ALL tests (no date filter) to verify filtering
const tests = await fetchTests();
console.log(`\nTotal tests from API: ${tests.length}`);

// Apply cutoff
const afterCutoff = tests.filter(t => {
  if (!t.currentDate) return false;
  return new Date(t.currentDate) >= cutoff;
});

afterCutoff.sort((a, b) => new Date(b.currentDate) - new Date(a.currentDate));
console.log(`Tests on or after ${CUTOFF_DATE}: ${afterCutoff.length}`);

afterCutoff.forEach((t, i) => {
  const already = isProcessed(state, t.testID) ? '✓ ALREADY SYNCED' : '◯ NEW';
  console.log(`  ${already} | ${t.userFirstName} ${t.userLastName} | ${t.currentDate} | testID: ${t.testID}`);
});

const newTests = afterCutoff.filter(t => !isProcessed(state, t.testID));
console.log(`\n${newTests.length} test(s) would be synced on next run`);

if (newTests.length > 0) {
  console.log('\nReady to sync these:');
  newTests.forEach(t => {
    console.log(`  → ${t.userFirstName} ${t.userLastName} (testID: ${t.testID}, ${t.currentDate})`);
  });
}

process.exit(0);
