import crypto from 'crypto';
import axios from 'axios';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
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

/**
 * Fetch normative percentile data for a test.
 * Uses GET /common/report with format=json and includeNorms=1.
 *
 * Returns an object like:
 *   { pVERBAL: '<1%', pVISUAL: '10%', pMSPEED: '<1%', pREACTI: '63%' }
 * or null if norms are unavailable.
 */
export async function fetchReportNorms(testID, recordTypeIdentifier) {
  const params = {
    token: USER_TOKEN,
    testIDs: String(testID),
    recordTypeIdentifier: recordTypeIdentifier || 'Sports',
    format: 'json',
    includeNorms: '1',
  };

  const signed = signParameters(params);
  const url = BASE_URL + 'common/report?' + new URLSearchParams(signed).toString();

  logger.debug('Fetching ImPACT report norms', { testID });

  const response = await axios.get(url, {
    headers: { Accept: 'application/json' },
    timeout: 30000,
  });

  const record = response.data?.report?.records?.[0];
  const norms = record?.norms || null;

  if (norms) {
    logger.info(`Fetched norms for test ${testID}`, norms);
  } else {
    logger.debug(`No norms available for test ${testID}`);
  }

  return norms;
}

// ─── PDF Overlay ────────────────────────────────────────────────

// Row positions on page 2 of the ImPACT Clinical Report (US Letter 612x792).
// Y values are in standard PDF coordinates (origin at bottom-left).
// Extracted from the content stream Tm operators of a v5.1.0 report.
const NORM_ROWS = [
  { key: 'pVERBAL', y: 537.12 },
  { key: 'pVISUAL', y: 522.37 },
  { key: 'pMSPEED', y: 507.62 },
  { key: 'pREACTI', y: 492.87 },
];

const NORM_X = 220;
const NORM_FONT_SIZE = 7;
const NORM_COLOR = rgb(0.21, 0.25, 0.32);

/**
 * Overlay normative percentile values onto the composite score table
 * on page 2 of an ImPACT Clinical Report PDF.
 *
 * @param {Buffer} pdfBuffer - Original PDF bytes
 * @param {object} norms     - { pVERBAL, pVISUAL, pMSPEED, pREACTI }
 * @returns {Buffer} Modified PDF bytes (or original if overlay fails)
 */
export async function overlayNormsOnPDF(pdfBuffer, norms) {
  try {
    const pdfDoc = await PDFDocument.load(pdfBuffer);
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const pages = pdfDoc.getPages();

    if (pages.length < 2) {
      logger.warn('PDF has fewer than 2 pages, skipping norm overlay');
      return pdfBuffer;
    }

    const page = pages[1];

    for (const row of NORM_ROWS) {
      const value = norms[row.key];
      if (!value) continue;

      page.drawText(value, {
        x: NORM_X,
        y: row.y,
        size: NORM_FONT_SIZE,
        font,
        color: NORM_COLOR,
      });
    }

    const modifiedBytes = await pdfDoc.save();
    logger.debug('Overlaid norms onto PDF');
    return Buffer.from(modifiedBytes);
  } catch (err) {
    logger.warn('Failed to overlay norms on PDF, using original', { error: err.message });
    return pdfBuffer;
  }
}
