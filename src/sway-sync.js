import { fetchRecentProfiles, downloadSwayTestPdf } from './sway-client.js';
import { findPatient, uploadDocument, documentExists, loadTokens } from './drchrono-client.js';
import { loadState, isProcessed, markProcessed } from './state.js';
import { sendUnmatchedAlert } from './notify.js';
import logger from './logger.js';

const CUTOFF_DATE = process.env.SYNC_CUTOFF_DATE || '2026-04-01';

/**
 * Run one Sway sync cycle:
 * 1. Fetch profiles with recent tests from Sway
 * 2. For each new test, match the patient in DrChrono
 * 3. Download the latest test PDF and upload it
 */
export async function runSwaySync() {
  const startTime = Date.now();
  logger.info('─── Sway sync cycle starting ───');

  loadTokens();
  const state = loadState();

  const lookbackHours = parseInt(process.env.LOOKBACK_HOURS || '24', 10);
  const now = new Date();
  const startDate = new Date(now.getTime() - lookbackHours * 60 * 60 * 1000);

  const cutoff = new Date(CUTOFF_DATE);
  const effectiveStart = startDate > cutoff ? startDate : cutoff;

  let profileEntries;
  try {
    profileEntries = await fetchRecentProfiles(effectiveStart);
  } catch (err) {
    logger.error('Failed to fetch profiles from Sway', {
      error: err.message,
      status: err.response?.status,
    });
    return;
  }

  if (!profileEntries.length) {
    logger.info('No Sway profiles with recent tests');
    return;
  }

  let successCount = 0;
  let failCount = 0;

  for (const { profile, tests } of profileEntries) {
    for (const test of tests) {
      const stateKey = `sway:${test.id}`;
      const labelSafe = `sway test ${test.id} (${test.completedOn})`;

      if (isProcessed(state, stateKey)) continue;

      try {
        // ── Step 1: Find the patient in DrChrono ──
        const dob = profile.birthDate
          ? new Date(profile.birthDate).toISOString().split('T')[0]
          : null;

        const patient = await findPatient(
          profile.firstName,
          profile.lastName,
          dob
        );

        if (!patient) {
          logger.warn(`SKIPPED: ${labelSafe} — no matching patient in DrChrono`);
          logger.debug(`Skipped Sway patient: ${profile.firstName} ${profile.lastName}`);
          await sendUnmatchedAlert({
            source: 'Sway',
            firstName: profile.firstName,
            lastName: profile.lastName,
            dob: dob,
            testId: test.id,
            testDate: test.completedOn,
            testType: test.organizationProtocolName,
          });
          failCount++;
          continue;
        }

        // ── Step 2: Server-side duplicate check ──
        const testIdTag = `[sway:${test.id}]`;
        const alreadyUploaded = await documentExists(
          patient.id, testIdTag, effectiveStart.toISOString()
        );
        if (alreadyUploaded) {
          logger.warn(`SKIPPED: ${labelSafe} — document already exists on patient ${patient.id}`);
          markProcessed(state, stateKey);
          continue;
        }

        // ── Step 3: Download the PDF from Sway ──
        const pdfBuffer = await downloadSwayTestPdf(profile.id);

        // ── Step 4: Upload to DrChrono ──
        const doctorId = patient.doctor || process.env.DRCHRONO_DOCTOR_ID;
        const protocolName = test.organizationProtocolName || 'Balance';
        const description = `Sway ${protocolName} Report ${testIdTag} — ${profile.firstName} ${profile.lastName}`;

        let testDate = now.toISOString().split('T')[0];
        if (test.completedOn) {
          try {
            testDate = new Date(test.completedOn).toISOString().split('T')[0];
          } catch { /* use today */ }
        }

        await uploadDocument(patient.id, doctorId, pdfBuffer, description, testDate, {
          filename: 'Sway_Report.pdf',
          metatags: ['Sway', 'Balance'],
        });

        markProcessed(state, stateKey);
        successCount++;
        logger.info(`✓ Synced: ${labelSafe} → patient ${patient.id}`);
        logger.debug(`Synced Sway patient: ${profile.firstName} ${profile.lastName}`);

      } catch (err) {
        failCount++;
        logger.error(`✗ Failed: ${labelSafe}`, {
          error: err.message,
          status: err.response?.status,
        });
      }
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  logger.info(`─── Sway sync complete: ${successCount} synced, ${failCount} failed (${elapsed}s) ───`);
}
