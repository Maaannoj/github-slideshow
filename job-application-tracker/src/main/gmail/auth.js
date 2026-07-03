'use strict';

/**
 * Gmail OAuth2 using the installed-app loopback flow. We spin up a throwaway
 * localhost server, open the Google consent screen in the user's browser, and
 * capture the auth code on redirect. Refresh tokens are persisted by the caller
 * (store.js) so the user only consents once.
 */

const http = require('http');
const { URL } = require('url');
const { google } = require('googleapis');

// Read-only Gmail access is all we need — the app never sends or deletes mail.
const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];

/**
 * Build an OAuth2 client from a Google "Desktop app" credentials.json blob.
 * Accepts either the {installed:{...}} or {web:{...}} shape.
 */
function createOAuthClient(credentials) {
  const conf = credentials.installed || credentials.web || credentials;
  if (!conf || !conf.client_id || !conf.client_secret) {
    throw new Error(
      'Invalid credentials.json — expected a Google OAuth "Desktop app" client with client_id and client_secret.'
    );
  }
  // Loopback redirect; the port is chosen at runtime and appended per-request.
  return new google.auth.OAuth2(conf.client_id, conf.client_secret, 'http://127.0.0.1');
}

/**
 * Run the interactive consent flow. `openBrowser` is injected so the main
 * process can use Electron's shell.openExternal.
 *
 * @param {object} credentials parsed credentials.json
 * @param {(url:string)=>void} openBrowser
 * @returns {Promise<{tokens:object, oAuth2Client:object}>}
 */
function authorize(credentials, openBrowser) {
  const oAuth2Client = createOAuthClient(credentials);

  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        const reqUrl = new URL(req.url, 'http://127.0.0.1');
        if (!reqUrl.searchParams.has('code') && !reqUrl.searchParams.has('error')) {
          res.writeHead(404).end();
          return;
        }
        const error = reqUrl.searchParams.get('error');
        if (error) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(pageHtml('Authorization was cancelled. You can close this tab.'));
          server.close();
          return reject(new Error('OAuth consent denied: ' + error));
        }
        const code = reqUrl.searchParams.get('code');
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(pageHtml('✅ Connected! You can close this tab and return to the app.'));
        server.close();

        const { tokens } = await oAuth2Client.getToken({
          code,
          redirect_uri: redirectUri,
        });
        oAuth2Client.setCredentials(tokens);
        resolve({ tokens, oAuth2Client });
      } catch (err) {
        try { server.close(); } catch (_) {}
        reject(err);
      }
    });

    let redirectUri;
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      redirectUri = `http://127.0.0.1:${port}`;
      const authUrl = oAuth2Client.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent',
        scope: SCOPES,
        redirect_uri: redirectUri,
      });
      openBrowser(authUrl);
    });

    server.on('error', reject);
  });
}

/**
 * Rebuild an authenticated client from stored tokens (no user interaction).
 */
function clientFromTokens(credentials, tokens) {
  const oAuth2Client = createOAuthClient(credentials);
  oAuth2Client.setCredentials(tokens);
  return oAuth2Client;
}

function pageHtml(message) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Job Application Tracker</title>
  <style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;background:#0f172a;color:#e2e8f0}
  .card{background:#1e293b;padding:2rem 3rem;border-radius:16px;box-shadow:0 10px 40px rgba(0,0,0,.4);font-size:1.1rem}</style>
  </head><body><div class="card">${message}</div></body></html>`;
}

module.exports = { authorize, clientFromTokens, createOAuthClient, SCOPES };
