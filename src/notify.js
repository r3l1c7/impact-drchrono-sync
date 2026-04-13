import nodemailer from 'nodemailer';
import logger from './logger.js';

const GMAIL_EMAIL = process.env.GMAIL_EMAIL;
const GMAIL_PASSWORD = (process.env.GMAIL_PASSWORD || '').replace(/\s/g, '');
const ALERT_TO = process.env.ALERT_EMAIL_TO;

let transporter = null;

function getTransporter() {
  if (!transporter && GMAIL_EMAIL && GMAIL_PASSWORD) {
    transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 587,
      secure: false,
      auth: { user: GMAIL_EMAIL, pass: GMAIL_PASSWORD },
    });
  }
  return transporter;
}

/**
 * Send an email alert when a test result cannot be matched to a
 * DrChrono patient. Staff can then manually transfer the report.
 *
 * @param {object} opts
 * @param {string} opts.source      - "ImPACT" or "Sway"
 * @param {string} opts.firstName
 * @param {string} opts.lastName
 * @param {string} opts.dob
 * @param {string} opts.testId
 * @param {string} opts.testDate
 * @param {string} [opts.testType]  - e.g. "Post-Injury 1", "Sports+"
 */
export async function sendUnmatchedAlert({ source, firstName, lastName, dob, testId, testDate, testType }) {
  if (!ALERT_TO) {
    logger.debug('ALERT_EMAIL_TO not set, skipping unmatched notification');
    return;
  }

  const t = getTransporter();
  if (!t) {
    logger.warn('Gmail credentials not configured, cannot send alert');
    return;
  }

  const subject = `[Action Required] ${source} test — patient not found in DrChrono`;

  const body = [
    `A ${source} test result could not be automatically uploaded because the patient was not found in DrChrono.`,
    ``,
    `Patient:   ${firstName} ${lastName}`,
    `DOB:       ${dob || 'unknown'}`,
    `Test ID:   ${testId}`,
    `Test Date: ${testDate || 'unknown'}`,
    `Test Type: ${testType || 'N/A'}`,
    ``,
    `Please locate this patient in DrChrono and manually transfer the report,`,
    `or verify the patient name/DOB matches between ${source} and DrChrono.`,
    ``,
    `Once the patient record is corrected or the report is manually uploaded,`,
    `the next sync cycle will skip this test automatically.`,
  ].join('\n');

  try {
    await t.sendMail({
      from: GMAIL_EMAIL,
      to: ALERT_TO,
      subject,
      text: body,
    });
    logger.info(`Unmatched-patient alert sent for ${source} test ${testId}`);
  } catch (err) {
    logger.error('Failed to send unmatched-patient alert', {
      error: err.message,
      testId,
    });
  }
}
