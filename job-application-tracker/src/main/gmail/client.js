'use strict';

/**
 * Thin wrapper over the Gmail API that fetches candidate job-application emails
 * and normalizes them into the shape the parser expects.
 */

const { google } = require('googleapis');

// Gmail search query that narrows the inbox to likely application mail before we
// even download it — keeps us well under API quota on large mailboxes.
const DEFAULT_QUERY = [
  '(',
  'subject:(application OR interview OR "your application" OR offer OR candidate OR recruiter OR assessment)',
  'OR from:(greenhouse.io OR lever.co OR myworkday.com OR ashbyhq.com OR smartrecruiters.com',
  'OR workable.com OR jobvite.com OR icims.com OR bamboohr.com OR breezy.hr OR recruitee.com',
  'OR teamtailor.com OR hackerrank.com OR codility.com OR linkedin.com OR indeed.com OR ziprecruiter.com)',
  ')',
].join(' ');

function headerValue(headers, name) {
  const h = (headers || []).find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : '';
}

/**
 * @param {object} authClient authenticated OAuth2 client
 * @param {{query?:string, maxResults?:number, newerThanDays?:number}} [opts]
 * @returns {Promise<Array<object>>} normalized emails
 */
async function fetchApplicationEmails(authClient, opts = {}) {
  const gmail = google.gmail({ version: 'v1', auth: authClient });
  const newerThan = opts.newerThanDays ? ` newer_than:${opts.newerThanDays}d` : '';
  const query = (opts.query || DEFAULT_QUERY) + newerThan;
  const maxResults = opts.maxResults || 300;

  // 1. Page through message IDs matching the query.
  const ids = [];
  let pageToken;
  do {
    const res = await gmail.users.messages.list({
      userId: 'me',
      q: query,
      maxResults: Math.min(100, maxResults - ids.length),
      pageToken,
    });
    for (const m of res.data.messages || []) ids.push(m.id);
    pageToken = res.data.nextPageToken;
  } while (pageToken && ids.length < maxResults);

  // 2. Fetch each message's metadata + snippet, with limited concurrency.
  const emails = [];
  const CONCURRENCY = 8;
  for (let i = 0; i < ids.length; i += CONCURRENCY) {
    const batch = ids.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map((id) =>
        gmail.users.messages
          .get({
            userId: 'me',
            id,
            format: 'metadata',
            metadataHeaders: ['Subject', 'From', 'Date'],
          })
          .then((r) => r.data)
          .catch(() => null)
      )
    );
    for (const msg of results) {
      if (!msg) continue;
      const headers = msg.payload && msg.payload.headers;
      emails.push({
        id: msg.id,
        threadId: msg.threadId,
        subject: headerValue(headers, 'Subject'),
        from: headerValue(headers, 'From'),
        snippet: decodeSnippet(msg.snippet || ''),
        date: Number(msg.internalDate) || Date.parse(headerValue(headers, 'Date')) || 0,
      });
    }
  }

  return emails;
}

// Gmail snippets arrive with HTML entities — decode the common ones.
function decodeSnippet(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ');
}

/**
 * Fetch the signed-in user's email address (for display / storage keying).
 */
async function getProfile(authClient) {
  const gmail = google.gmail({ version: 'v1', auth: authClient });
  const res = await gmail.users.getProfile({ userId: 'me' });
  return res.data; // { emailAddress, messagesTotal, ... }
}

module.exports = { fetchApplicationEmails, getProfile, DEFAULT_QUERY };
