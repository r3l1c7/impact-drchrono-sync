import axios from 'axios';
import FormData from 'form-data';
import fs from 'fs';
import logger from './logger.js';

// ═══════════════════════════════════════════════════════════════
//  DrChrono API Client
//  Handles OAuth2 token refresh, patient search, document upload
// ═══════════════════════════════════════════════════════════════

const DRCHRONO_BASE = 'https://app.drchrono.com';
const TOKEN_FILE = './data/drchrono-tokens.json';

let accessToken = process.env.DRCHRONO_ACCESS_TOKEN;
let refreshToken = process.env.DRCHRONO_REFRESH_TOKEN;

// ─── Token Management ──────────────────────────────────────────

/**
 * Load saved tokens (if the token was refreshed at runtime,
 * we persist it so restarts don't lose it).
 */
export function loadTokens() {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      const saved = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
      if (saved.access_token) accessToken = saved.access_token;
      if (saved.refresh_token) refreshToken = saved.refresh_token;
      logger.debug('Loaded saved DrChrono tokens');
    }
  } catch {
    // Fall back to env vars
  }
}

function saveTokens() {
  try {
    const dir = './data';
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(TOKEN_FILE, JSON.stringify({
      access_token: accessToken,
      refresh_token: refreshToken,
      updated_at: new Date().toISOString(),
    }, null, 2));
  } catch (err) {
    logger.warn('Could not persist DrChrono tokens', { error: err.message });
  }
}

/**
 * Refresh the OAuth2 access token using the refresh token.
 * DrChrono access tokens expire every 48 hours.
 * The refresh token does NOT expire unless you re-OAuth or revoke.
 */
async function refreshAccessToken() {
  logger.info('Refreshing DrChrono access token...');

  const response = await axios.post(`${DRCHRONO_BASE}/o/token/`, new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: process.env.DRCHRONO_CLIENT_ID,
    client_secret: process.env.DRCHRONO_CLIENT_SECRET,
  }), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });

  accessToken = response.data.access_token;
  refreshToken = response.data.refresh_token;
  saveTokens();

  logger.info('DrChrono token refreshed successfully');
}

/**
 * Make an authenticated request to DrChrono.
 * Automatically retries once on 401 after refreshing the token.
 */
async function drchronoRequest(config) {
  const makeRequest = () => axios({
    ...config,
    baseURL: DRCHRONO_BASE,
    headers: {
      ...config.headers,
      Authorization: `Bearer ${accessToken}`,
    },
    timeout: config.timeout || 30000,
  });

  try {
    return await makeRequest();
  } catch (err) {
    if (err.response?.status === 401) {
      await refreshAccessToken();
      return await makeRequest();
    }
    throw err;
  }
}

// ─── Patient Search ────────────────────────────────────────────

/**
 * Convert ImPACT DOB format (MM/DD/YYYY) to DrChrono format (YYYY-MM-DD).
 */
function formatDOB(impactDOB) {
  if (!impactDOB) return null;

  // Already in YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(impactDOB)) return impactDOB;

  // MM/DD/YYYY → YYYY-MM-DD
  const parts = impactDOB.split('/');
  if (parts.length === 3) {
    return `${parts[2]}-${parts[0].padStart(2, '0')}-${parts[1].padStart(2, '0')}`;
  }

  logger.warn('Unrecognized DOB format', { dob: impactDOB });
  return null;
}

/**
 * Check whether two first names are compatible:
 * exact match, or one is a prefix of the other (e.g. "Santa" / "Santagiselle").
 */
function firstNameCompatible(impactName, drchronoName) {
  const a = (impactName || '').trim().toUpperCase();
  const b = (drchronoName || '').trim().toUpperCase();
  if (!a || !b) return false;
  return a === b || a.startsWith(b) || b.startsWith(a);
}

/**
 * Search for a patient in DrChrono by name and DOB.
 *
 * Strategy:
 *   1. Exact match: first_name + last_name + DOB
 *   2. Fallback:    last_name + DOB only
 *      - Accept if exactly 1 result AND first name is a prefix match
 *      - Skip if 0 results, 2+ results, or name doesn't partially match
 *
 * Returns the matching patient object, or null.
 */
export async function findPatient(firstName, lastName, dob) {
  const formattedDOB = formatDOB(dob);

  // ── Pass 1: exact first + last + DOB ──
  const exactParams = { first_name: firstName, last_name: lastName };
  if (formattedDOB) exactParams.date_of_birth = formattedDOB;

  logger.debug('Searching DrChrono for patient', { lastName, dob: formattedDOB });

  const exactResp = await drchronoRequest({
    method: 'GET',
    url: '/api/patients',
    params: exactParams,
  });

  const exactResults = exactResp.data.results || [];

  if (exactResults.length === 1) {
    const patient = exactResults[0];
    logger.info(`Found patient ID: ${patient.id}`);
    logger.debug(`Patient match: ${patient.first_name} ${patient.last_name}`);
    return patient;
  }

  if (exactResults.length > 1) {
    logger.warn(`Multiple patients matched — using first (ID: ${exactResults[0].id})`);
    logger.debug(`Multi-match for: ${firstName} ${lastName}`);
    return exactResults[0];
  }

  // ── Pass 2: fallback to last_name + DOB only ──
  if (!formattedDOB) {
    logger.warn(`No patient found in DrChrono for given name/DOB`);
    logger.debug(`Unmatched patient: ${firstName} ${lastName} (DOB: ${dob})`);
    return null;
  }

  logger.debug('Exact match failed, trying last_name + DOB fallback');

  const fallbackResp = await drchronoRequest({
    method: 'GET',
    url: '/api/patients',
    params: { last_name: lastName, date_of_birth: formattedDOB },
  });

  const fallbackResults = fallbackResp.data.results || [];

  if (fallbackResults.length === 0) {
    logger.warn(`No patient found in DrChrono for given name/DOB`);
    logger.debug(`Unmatched patient: ${firstName} ${lastName} (DOB: ${dob})`);
    return null;
  }

  if (fallbackResults.length > 1) {
    logger.warn(`Fuzzy search returned ${fallbackResults.length} patients for same last name + DOB — skipping (ambiguous)`);
    return null;
  }

  const candidate = fallbackResults[0];

  if (!firstNameCompatible(firstName, candidate.first_name)) {
    logger.warn(`Fuzzy match rejected: first names not compatible ("${firstName}" vs "${candidate.first_name}")`);
    return null;
  }

  logger.info(`Found patient ID: ${candidate.id} (fuzzy match: "${candidate.first_name}" ≈ "${firstName}")`);
  return candidate;
}

// ─── Document Upload ───────────────────────────────────────────

/**
 * Upload a PDF to a patient's chart in DrChrono.
 *
 * THIS IS THE FIX for your Zapier version:
 * - Uses the `form-data` library to build proper multipart/form-data
 * - Sends the PDF as actual binary (Buffer), NOT base64-encoded text
 * - DrChrono expects `document` field to be a real file upload
 *
 * @param {number} patientId  - DrChrono patient ID
 * @param {number} doctorId   - DrChrono doctor ID
 * @param {Buffer} pdfBuffer  - Raw PDF bytes
 * @param {string} description - Document description
 * @param {string} testDate   - Date string for the document
 * @returns {object} Upload result
 */
export async function uploadDocument(patientId, doctorId, pdfBuffer, description, testDate) {
  // Build a real multipart form with the form-data library
  const form = new FormData();
  form.append('doctor', String(doctorId));
  form.append('patient', String(patientId));
  form.append('description', description);
  form.append('date', testDate || new Date().toISOString().split('T')[0]);
  form.append('metatags', JSON.stringify(['ImPACT', 'Concussion']));

  // THIS is the key difference from your Zapier code:
  // Append the PDF as a real binary buffer with proper filename and MIME type.
  // The form-data library handles the multipart boundary and encoding correctly.
  form.append('document', pdfBuffer, {
    filename: `ImPACT_Report.pdf`,
    contentType: 'application/pdf',
  });

  logger.debug('Uploading document to DrChrono', { patientId, doctorId, size: pdfBuffer.length });

  const response = await drchronoRequest({
    method: 'POST',
    url: '/api/documents',
    data: form,
    headers: form.getHeaders(),  // Sets correct Content-Type with boundary
    timeout: 60000,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
  });

  logger.info(`Document uploaded to patient ${patientId}`, {
    documentId: response.data?.id,
    status: response.status,
  });

  return response.data;
}
