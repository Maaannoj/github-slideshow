'use strict';

/**
 * Thin wrapper over the Gmail API that fetches candidate job-application emails
 * and normalizes them into the shape the parser expects.
 */

const { google } = require('googleapis');

// Gmail search query that narrows the inbox to likely application mail before we
// even download it — keeps us well under API quota on large mailboxes.
//
// This casts a wide net on purpose: it matches job-specific PHRASES anywhere in
// the email (subject or body), not just a few subject keywords, plus a broad set
// of applicant-tracking / job-board sender domains. The classifier downstream is
// responsible for filtering out anything that slips through that isn't really a
// job-application email, so we err toward capturing too much here.
const DEFAULT_QUERY = [
  '(',
  // Strong application / status phrases (matched in subject OR body).
  '"thank you for applying" OR "thanks for applying" OR "thank you for your interest"',
  'OR "your application" OR "we received your application" OR "application has been received"',
  'OR "application was received" OR "received your application" OR "application for the"',
  'OR "your recent application" OR "your recent job application" OR "application status"',
  'OR "update on your application" OR "your candidacy" OR "your interest in"',
  // Rejection phrases.
  'OR "we regret to inform" OR "not to move forward" OR "not be moving forward"',
  'OR "will not be moving forward" OR "move forward with other" OR "other candidates"',
  'OR "not been selected" OR "were not selected" OR "position has been filled"',
  'OR "decided not to proceed" OR "pursue other candidates" OR "unfortunately"',
  'OR "sorry to see you go"',
  // Interview / assessment / offer phrases.
  'OR "schedule an interview" OR "invite you to interview" OR "phone screen"',
  'OR "next steps" OR "coding challenge" OR "online assessment" OR "take-home"',
  'OR "pleased to offer" OR "offer of employment" OR "we are excited to offer"',
  // Broad subject keywords as a backstop.
  'OR subject:(application OR interview OR candidate OR recruiter OR assessment OR "job application")',
  // Applicant-tracking systems and job boards (sender domains).
  'OR from:(greenhouse.io OR lever.co OR myworkday.com OR myworkdayjobs.com OR ashbyhq.com',
  'OR smartrecruiters.com OR workable.com OR jobvite.com OR icims.com OR bamboohr.com',
  'OR breezy.hr OR recruitee.com OR teamtailor.com OR hackerrank.com OR codility.com',
  'OR hackerearth.com OR linkedin.com OR indeed.com OR indeedemail.com OR ziprecruiter.com',
  'OR glassdoor.com OR wellfound.com OR successfactors.com OR taleo.net OR eightfold.ai',
  'OR phenompeople.com OR avature.net OR oraclecloud.com OR paylocity.com OR dayforcehcm.com)',
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
