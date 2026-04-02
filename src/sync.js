import { fetchTests, downloadReportPDF } from './impact-client.js';
import { findPatient, uploadDocument, loadTokens } from './drchrono-client.js';
import { loadState, isProcessed, markProcessed } from './state.js';
import logger from './logger.js';

// ─── Hard cutoff: ignore all tests before this date ────────────
// Nothing from before 4/1/2026 should ever be processed.
const CUTOFF_DATE = process.env.SYNC_CUTOFF_DATE || '2026-04-01';

/**
 * Run one sync cycle:
 * 1. Fetch recent tests from ImPACT
 * 2. Skip any before the cutoff date or already processed
 * 3. For each new test (newest first):
 *    a. Search DrChrono for the patient by name + DOB
 *    b. Download the ImPACT PDF report
 *    c. Upload it to the patient's chart
 */
export async function runSync() {
  const startTime = Date.now();
  logger.info('─── Sync cycle starting ───');

  // Load persisted DrChrono tokens (in case they were refreshed previously)
  loadTokens();

  const state = loadState();

  // Calculate date range for the lookback window
  const lookbackHours = parseInt(process.env.LOOKBACK_HOURS || '24', 10);
  const now = new Date();
  const startDate = new Date(now.getTime() - lookbackHours * 60 * 60 * 1000);

  // Never look back before the cutoff date
  const cutoff = new Date(CUTOFF_DATE);
  const effectiveStart = startDate > cutoff ? startDate : cutoff;

  let tests;
  try {
    tests = await fetchTests({
      startDate: effectiveStart.toISOString().split('T')[0],
      endDate: now.toISOString().split('T')[0],
    });
  } catch (err) {
    logger.error('Failed to fetch tests from ImPACT', {
      error: err.message,
      status: err.response?.status,
    });
    return;
  }

  if (!tests.length) {
    logger.info('No tests found in lookback window');
    return;
  }

  // Filter out tests before the cutoff date (belt-and-suspenders in case
  // the API ignores our startDate filter)
  const afterCutoff = tests.filter(t => {
    if (!t.currentDate) return false;
    return new Date(t.currentDate) >= cutoff;
  });

  if (afterCutoff.length < tests.length) {
    logger.info(`Filtered out ${tests.length - afterCutoff.length} test(s) before cutoff ${CUTOFF_DATE}`);
  }

  // Sort by date descending so we process the most recent tests first
  afterCutoff.sort((a, b) => new Date(b.currentDate) - new Date(a.currentDate));

  // Filter to unprocessed tests only
  const newTests = afterCutoff.filter(t => !isProcessed(state, t.testID));
  logger.info(`${newTests.length} new test(s) to process (${afterCutoff.length - newTests.length} already synced)`);

  let successCount = 0;
  let failCount = 0;

  for (const test of newTests) {
    const labelSafe = `test ${test.testID} (${test.currentDate})`;
    const labelFull = `${test.userFirstName} ${test.userLastName} — ${labelSafe}`;

    try {
      // ── Step 1: Find the patient in DrChrono ──
      const patient = await findPatient(
        test.userFirstName,
        test.userLastName,
        test.userDateOfBirth
      );

      if (!patient) {
        logger.warn(`SKIPPED: ${labelSafe} — no matching patient in DrChrono`);
        logger.debug(`Skipped patient: ${labelFull}`);
        // Don't mark as processed — we'll retry next cycle in case
        // the patient gets added to DrChrono later
        failCount++;
        continue;
      }

      // ── Step 2: Download the PDF from ImPACT ──
      const pdfBuffer = await downloadReportPDF(
        test.testID,
        test.recordTypeIdentifier || 'Sports'
      );

      // ── Step 3: Upload to DrChrono ──
      const doctorId = patient.doctor || process.env.DRCHRONO_DOCTOR_ID;
      const description = `ImPACT ${test.testType || 'Test'} Report — ${test.userFirstName} ${test.userLastName}`;

      // Format the test date for DrChrono (YYYY-MM-DD)
      let testDate = now.toISOString().split('T')[0];
      if (test.currentDate) {
        try {
          testDate = new Date(test.currentDate).toISOString().split('T')[0];
        } catch { /* use today */ }
      }

      await uploadDocument(patient.id, doctorId, pdfBuffer, description, testDate);

      // ── Mark as done ──
      markProcessed(state, test.testID);
      successCount++;
      logger.info(`✓ Synced: ${labelSafe} → patient ${patient.id}`);
      logger.debug(`Synced patient: ${labelFull}`);

    } catch (err) {
      failCount++;
      logger.error(`✗ Failed: ${labelSafe}`, {
        error: err.message,
        status: err.response?.status,
      });
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  logger.info(`─── Sync complete: ${successCount} synced, ${failCount} failed (${elapsed}s) ───`);
}
