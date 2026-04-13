import axios from 'axios';
import logger from './logger.js';

// ═══════════════════════════════════════════════════════════════
//  Sway Medical API Client
//  Base URL: https://api.swaymedical.com
//  Auth: API key sent as X-ApiKey header
// ═══════════════════════════════════════════════════════════════

const BASE_URL = process.env.SWAY_BASE_URL || 'https://api.swaymedical.com';
const API_KEY = process.env.SWAY_API_KEY;

function swayRequest(endpoint, body = {}) {
  return axios.post(`${BASE_URL}${endpoint}`, body, {
    headers: {
      'Content-Type': 'application/json',
      'X-ApiKey': API_KEY,
    },
    timeout: 30000,
  });
}

// ─── API Calls ─────────────────────────────────────────────────

/**
 * Validate the API key and return the organization ID.
 * Useful as a startup health-check.
 */
export async function getOrganizationId() {
  const resp = await swayRequest('/api/Auxiliary/GetOrganizationId');
  const data = resp.data;

  if (!data.isSuccess) {
    const msg = data.errors?.map(e => e.message).join('; ') || 'Unknown error';
    throw new Error(`Sway API key validation failed: ${msg}`);
  }

  logger.info(`Sway organization validated (ID: ${data.organizationId})`);
  return data.organizationId;
}

/**
 * Fetch profiles that have been tested recently, sorted by last test date.
 * Pages through GetProfileDetailPaged (max 10 per page) until all profiles
 * with lastTestDate >= lookbackDate have been collected.
 *
 * Returns a flat array of objects: { profile, tests }
 * where `tests` only includes tests with completedOn >= lookbackDate.
 *
 * @param {Date} lookbackDate - Only include profiles/tests newer than this
 * @returns {Array<{profile: object, tests: object[]}>}
 */
export async function fetchRecentProfiles(lookbackDate) {
  const results = [];
  let pageNumber = 1;
  let done = false;

  while (!done) {
    logger.debug(`Fetching Sway profiles page ${pageNumber}`);

    const resp = await swayRequest('/api/Profile/GetProfileDetailPaged', {
      pageNumber,
      rowsPerPage: 10,
      sortByColumn: 'lastTestDate',
      sortAscending: false,
      returnInactive: false,
    });

    const data = resp.data;

    if (!data.isSuccess) {
      const msg = data.errors?.map(e => e.message).join('; ') || 'Unknown error';
      throw new Error(`Sway GetProfileDetailPaged failed: ${msg}`);
    }

    const profiles = data.profiles || [];

    if (profiles.length === 0) {
      done = true;
      break;
    }

    for (const entry of profiles) {
      const prof = entry.profile;
      if (!prof) continue;

      const lastTest = prof.lastTestDate ? new Date(prof.lastTestDate) : null;

      if (!lastTest || lastTest < lookbackDate) {
        done = true;
        break;
      }

      const allTests = entry.tests || [];
      const recentTests = allTests.filter(t => {
        if (!t.completedOn) return false;
        return new Date(t.completedOn) >= lookbackDate;
      });

      if (recentTests.length > 0) {
        results.push({ profile: prof, tests: recentTests });
      }
    }

    pageNumber++;
  }

  logger.info(`Fetched ${results.length} Sway profile(s) with recent tests`);
  return results;
}

/**
 * Download the Clinical Report PDF for a profile's latest test.
 *
 * @param {number|string} profileId - Sway profile ID
 * @returns {Buffer} Raw PDF bytes
 */
export async function downloadSwayTestPdf(profileId) {
  logger.debug('Downloading Sway test PDF', { profileId });

  const resp = await axios.post(
    `${BASE_URL}/api/Profile/GetProfileLatestTestPdf`,
    { profileId: Number(profileId) },
    {
      headers: {
        'Content-Type': 'application/json',
        'X-ApiKey': API_KEY,
      },
      responseType: 'arraybuffer',
      timeout: 60000,
    }
  );

  const pdfBuffer = Buffer.from(resp.data);
  logger.info(`Downloaded Sway PDF for profile ${profileId} (${(pdfBuffer.length / 1024).toFixed(1)} KB)`);
  return pdfBuffer;
}
