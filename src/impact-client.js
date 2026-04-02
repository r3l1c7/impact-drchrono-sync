import crypto from 'crypto';
import axios from 'axios';
import logger from './logger.js';

// ═══════════════════════════════════════════════════════════════
//  ImPACT API Client
//  Base URL: https://mobile.impacttestonline.com/impactAPI/
//  Auth: HMAC-SHA256 signed query parameters
// ═══════════════════════════════════════════════════════════════

const BASE_URL = process.env.IMPACT_BASE_URL || 'https://mobile.impacttestonline.com/impactAPI/';
const PUBLIC_API_KEY = process.env.IMPACT_PUBLIC_API_KEY;
const PRIVATE_API_KEY = process.env.IMPACT_PRIVATE_API_KEY;
const LOCATION_CODE = process.env.IMPACT_LOCATION_CODE || 'US';
const USER_TOKEN = process.env.IMPACT_USER_TOKEN;
const ORG_ID = process.env.IMPACT_ORG_ID;

// ─── Signing ───────────────────────────────────────────────────

function utcTimestamp() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00');
}

/**
 * Signs parameters using ImPACT's HMAC-SHA256 scheme.
 * 1. Lowercase each key, concatenate with its value
 * 2. Sort those strings case-insensitively
 * 3. Join them all and HMAC-SHA256 with the private key
 * 4. Base64-encode the result
 */
function signParameters(params) {
  const p = { ...params };

  // Add required auth fields
  p.apiKey = PUBLIC_API_KEY;
  p.timeStamp = utcTimestamp();
  p.locationCode = LOCATION_CODE;

  // Build key+value pairs (skip 'signature' itself)
  const pairs = [];
  for (const [key, value] of Object.entries(p)) {
    const lowerKey = key.toLocaleLowerCase('en-US');
    if (lowerKey !== 'signature') {
      pairs.push(lowerKey + (value ?? ''));
    }
  }

  // Sort case-insensitively
  pairs.sort((a, b) =>
    a.toLocaleLowerCase('en-US').localeCompare(b.toLocaleLowerCase('en-US'), 'en-US')
  );

  // HMAC-SHA256 → base64
  const hmac = crypto.createHmac('sha256', PRIVATE_API_KEY);
  hmac.update(pairs.join(''));
  p.signature = hmac.digest('base64');

  return p;
}

// ─── API Calls ─────────────────────────────────────────────────

/**
 * Fetch test records from ImPACT.
 * Uses GET /common/tests with orgID and optional date filters.
 *
 * Returns array of test objects, each containing:
 *   testID, userFirstName, userLastName, userDateOfBirth,
 *   testType, recordTypeIdentifier, currentDate, etc.
 */
export async function fetchTests({ startDate, endDate } = {}) {
  const params = { token: USER_TOKEN };
  if (ORG_ID) params.orgID = ORG_ID;
  if (startDate) params.startDate = startDate;
  if (endDate) params.endDate = endDate;

  const signed = signParameters(params);
  const url = BASE_URL + 'common/tests?' + new URLSearchParams(signed).toString();

  logger.debug('Fetching ImPACT tests', { url: url.replace(/signature=[^&]+/, 'signature=***') });

  const response = await axios.get(url, {
    headers: { Accept: 'application/json' },
    timeout: 30000,
  });

  const data = response.data;

  // The API may return a refreshed token — log it but we don't
  // auto-rotate tokens here (it's a JWT, usually long-lived).
  if (data.token && data.token !== USER_TOKEN) {
    logger.info('ImPACT returned a new token — consider updating IMPACT_USER_TOKEN in .env');
  }

  const tests = data.tests || [];
  logger.info(`Fetched ${tests.length} test(s) from ImPACT`);
  return tests;
}

/**
 * Download a PDF report for a given test.
 * Uses GET /common/report with testIDs and recordTypeIdentifier.
 *
 * Returns a Buffer containing the raw PDF bytes.
 */
export async function downloadReportPDF(testID, recordTypeIdentifier) {
  const params = {
    token: USER_TOKEN,
    testIDs: String(testID),
    recordTypeIdentifier: recordTypeIdentifier || 'Sports',
  };

  const signed = signParameters(params);
  const url = BASE_URL + 'common/report?' + new URLSearchParams(signed).toString();

  logger.debug('Downloading ImPACT report PDF', { testID, recordTypeIdentifier });

  const response = await axios.get(url, {
    headers: { Accept: 'application/pdf' },
    responseType: 'arraybuffer',
    timeout: 60000,
  });

  const pdfBuffer = Buffer.from(response.data);
  logger.info(`Downloaded PDF for test ${testID} (${(pdfBuffer.length / 1024).toFixed(1)} KB)`);
  return pdfBuffer;
}
