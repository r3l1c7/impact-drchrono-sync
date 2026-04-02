import 'dotenv/config';
import http from 'http';
import { URL } from 'url';
import axios from 'axios';

// ═══════════════════════════════════════════════════════════════
//  DrChrono OAuth2 Token Setup
//
//  This script starts a local server, opens the DrChrono OAuth
//  flow, and exchanges the authorization code for tokens.
//
//  Usage:
//    1. Set DRCHRONO_CLIENT_ID and DRCHRONO_CLIENT_SECRET in .env
//    2. Add http://localhost:3456/callback as a Redirect URI
//       in your DrChrono app settings
//    3. Run: npm run setup:token
//    4. Open the URL it prints in your browser
//    5. Authorize the app — tokens will be saved automatically
// ═══════════════════════════════════════════════════════════════

const PORT = 3456;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;
const CLIENT_ID = process.env.DRCHRONO_CLIENT_ID;
const CLIENT_SECRET = process.env.DRCHRONO_CLIENT_SECRET;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Set DRCHRONO_CLIENT_ID and DRCHRONO_CLIENT_SECRET in .env first.');
  process.exit(1);
}

const authUrl = `https://drchrono.com/o/authorize/?response_type=code&client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=patients:read%20documents:write%20documents:read%20user:read`;

console.log('\n1. Add this Redirect URI to your DrChrono app:');
console.log(`   ${REDIRECT_URI}\n`);
console.log('2. Open this URL in your browser:');
console.log(`   ${authUrl}\n`);
console.log('Waiting for callback...\n');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname !== '/callback') {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (error) {
    res.writeHead(400);
    res.end(`Authorization failed: ${error}`);
    server.close();
    process.exit(1);
  }

  if (!code) {
    res.writeHead(400);
    res.end('No authorization code received');
    return;
  }

  try {
    const tokenRes = await axios.post('https://drchrono.com/o/token/', new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    const { access_token, refresh_token } = tokenRes.data;

    console.log('✓ Tokens received!\n');
    console.log('Add these to your .env file:\n');
    console.log(`DRCHRONO_ACCESS_TOKEN=${access_token}`);
    console.log(`DRCHRONO_REFRESH_TOKEN=${refresh_token}`);

    // Also try to get the doctor ID
    try {
      const userRes = await axios.get('https://app.drchrono.com/api/users/current', {
        headers: { Authorization: `Bearer ${access_token}` },
      });
      const doctorId = userRes.data.doctor;
      if (doctorId) {
        console.log(`DRCHRONO_DOCTOR_ID=${doctorId}`);
      }
    } catch { /* non-critical */ }

    console.log('');

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<h1>Success!</h1><p>Tokens have been printed to your terminal. You can close this window.</p>');
  } catch (err) {
    console.error('Token exchange failed:', err.response?.data || err.message);
    res.writeHead(500);
    res.end('Token exchange failed. Check your terminal.');
  }

  server.close();
  setTimeout(() => process.exit(0), 1000);
});

server.listen(PORT, '127.0.0.1');
