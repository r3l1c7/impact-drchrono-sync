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
 * Check whether two last names are compatible for compound name matching.
 * Returns true if one contains the other as a whole word.
 * e.g. "Perez Varela" contains "Varela", "Varela" is in "Perez Varela".
 */
function lastNameCompatible(searchName, drchronoName) {
  const a = (searchName || '').trim().toUpperCase();
  const b = (drchronoName || '').trim().toUpperCase();
  if (!a || !b) return false;
  return a === b || b.includes(a) || a.includes(b);
}

/**
 * Try to confirm a single candidate from a DOB search.
 * Checks first name compatibility and returns the patient or null.
 */
function confirmCandidate(candidate, firstName, matchType) {
  if (!firstNameCompatible(firstName, candidate.first_name)) {
    logger.warn(`${matchType} rejected: first names not compatible ("${firstName}" vs "${candidate.first_name}")`);
    return null;
  }
  logger.info(`Found patient ID: ${candidate.id} (${matchType}: "${candidate.first_name} ${candidate.last_name}" for "${firstName}")`);
  return candidate;
}

/**
 * Search for a patient in DrChrono by name and DOB.
 *
 * Strategy:
 *   1. Exact match:     first_name + last_name + DOB
 *   2. Last name + DOB: drop first_name, require 1 result with compatible first name
 *   3. DOB only:        handle compound last names (e.g. "Varela" vs "Perez Varela")
 *      - Search by DOB alone, filter results where last name contains the search term
 *      - Accept only if exactly 1 candidate survives AND first name is compatible
 *
 * Returns the matching patient object, or null.
 */
export async function findPatient(firstName, lastName, dob) {
  const formattedDOB = formatDOB(dob);
  const trimmedFirst = (firstName || '').trim();
  const trimmedLast = (lastName || '').trim();

  // ── Pass 1: exact first + last + DOB ──
  const exactParams = { first_name: trimmedFirst, last_name: trimmedLast };
  if (formattedDOB) exactParams.date_of_birth = formattedDOB;

  logger.debug('Searching DrChrono for patient', { lastName: trimmedLast, dob: formattedDOB });

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
    logger.debug(`Multi-match for: ${trimmedFirst} ${trimmedLast}`);
    return exactResults[0];
  }

  if (!formattedDOB) {
    logger.warn(`No patient found in DrChrono for given name/DOB`);
    logger.debug(`Unmatched patient: ${trimmedFirst} ${trimmedLast} (DOB: ${dob})`);
    return null;
  }

  // ── Pass 2: last_name + DOB only (first name mismatch) ──
  logger.debug('Exact match failed, trying last_name + DOB fallback');

  const fallbackResp = await drchronoRequest({
    method: 'GET',
    url: '/api/patients',
    params: { last_name: trimmedLast, date_of_birth: formattedDOB },
  });

  const fallbackResults = fallbackResp.data.results || [];

  if (fallbackResults.length === 1) {
    const match = confirmCandidate(fallbackResults[0], trimmedFirst, 'fuzzy match');
    if (match) return match;
  } else if (fallbackResults.length > 1) {
    logger.warn(`Pass 2 returned ${fallbackResults.length} patients for same last name + DOB — skipping (ambiguous)`);
  }

  // ── Pass 3: DOB only — compound last name handling ──
  // e.g. Sway has "Varela" but DrChrono has "Perez Varela"
  logger.debug('Trying DOB-only search for compound last name match');

  const dobResp = await drchronoRequest({
    method: 'GET',
    url: '/api/patients',
    params: { date_of_birth: formattedDOB },
  });

  const dobResults = dobResp.data.results || [];
  const lastNameCandidates = dobResults.filter(p =>
    lastNameCompatible(trimmedLast, p.last_name)
  );

  if (lastNameCandidates.length === 1) {
    const match = confirmCandidate(lastNameCandidates[0], trimmedFirst, 'compound name match');
    if (match) return match;
  } else if (lastNameCandidates.length > 1) {
    logger.warn(`Pass 3 returned ${lastNameCandidates.length} DOB+last-name candidates — skipping (ambiguous)`);
  }

  logger.warn(`No patient found in DrChrono for given name/DOB`);
  logger.debug(`Unmatched patient: ${trimmedFirst} ${trimmedLast} (DOB: ${dob})`);
  return null;
}

// ─── Document Duplicate Check ───────────────────────────────────

/**
 * Check whether a document with a given test ID tag already exists
 * on a patient's chart. Used as a server-side safety net so we never
 * upload the same report twice, even if the local state file is lost.
 *
 * @param {number} patientId - DrChrono patient ID
 * @param {string} testIdTag - Tag to search for, e.g. "[impact:26762488]"
 * @param {string} [sinceDate] - ISO date string to limit the search window
 * @returns {boolean} true if a matching document already exists
 */
export async function documentExists(patientId, testIdTag, sinceDate) {
  const params = { patient: patientId };
  if (sinceDate) {
    // DrChrono rejects timezone suffixes — strip trailing Z or offset
    params.since = sinceDate.replace(/[Z+].*$/, '');
  }

  const resp = await drchronoRequest({
    method: 'GET',
    url: '/api/documents',
    params,
  });

  const docs = resp.data.results || [];
  return docs.some(d => (d.description || '').includes(testIdTag));
}

// ─── Document Upload ───────────────────────────────────────────

/**
 * Upload a PDF to a patient's chart in DrChrono.
 *
 * @param {number} patientId   - DrChrono patient ID
 * @param {number} doctorId    - DrChrono doctor ID
 * @param {Buffer} pdfBuffer   - Raw PDF bytes
 * @param {string} description - Document description
 * @param {string} testDate    - Date string for the document
 * @param {object} [opts]
 * @param {string} [opts.filename='ImPACT_Report.pdf']
 * @param {string[]} [opts.metatags=['ImPACT','Concussion']]
 * @returns {object} Upload result
 */
export async function uploadDocument(patientId, doctorId, pdfBuffer, description, testDate, {
  filename = 'ImPACT_Report.pdf',
  metatags = ['ImPACT', 'Concussion'],
} = {}) {
  const form = new FormData();
  form.append('doctor', String(doctorId));
  form.append('patient', String(patientId));
  form.append('description', description);
  form.append('date', testDate || new Date().toISOString().split('T')[0]);
  form.append('metatags', JSON.stringify(metatags));

  form.append('document', pdfBuffer, {
    filename,
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
