'use strict';

/**
 * Extracts a human-friendly company name and (best-effort) role title from an
 * email so applications can be grouped on the board. Pure/testable, like the
 * classifier.
 */

const { domainOf } = require('./classifier');

// Sender domains that are generic mailers rather than the hiring company, so we
// should NOT use them as the company name and instead fall back to the subject.
const GENERIC_SENDER_DOMAINS = [
  'greenhouse.io',
  'lever.co',
  'hire.lever.co',
  'myworkday.com',
  'myworkdayjobs.com',
  'ashbyhq.com',
  'smartrecruiters.com',
  'workable.com',
  'jobvite.com',
  'icims.com',
  'taleo.net',
  'bamboohr.com',
  'breezy.hr',
  'recruitee.com',
  'teamtailor.com',
  'linkedin.com',
  'indeed.com',
  'indeedemail.com',
  'ziprecruiter.com',
  'glassdoor.com',
  'wellfound.com',
  'hackerrank.com',
  'codility.com',
  'calendly.com',
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'yahoo.com',
];

function titleCase(str) {
  return str
    .replace(/[._-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}

function companyFromDomain(domain) {
  if (!domain) return '';
  // strip known public suffixes to get the second-level label
  const parts = domain.split('.');
  // e.g. jobs.acme.com -> acme ; careers.acme.co.uk -> acme
  const idx = parts.length >= 2 ? parts.length - 2 : 0;
  const label = parts[idx] || parts[0];
  return titleCase(label);
}

// ATS hosts where the company appears as the LEFTMOST subdomain label, e.g.
// "acme.greenhouse.io" or "acme.myworkdayjobs.com". Anything ending in one of
// these with a meaningful leading label lets us recover the real company.
const ATS_SUBDOMAIN_HOSTS = [
  'greenhouse.io',
  'myworkday.com',
  'myworkdayjobs.com',
  'jobvite.com',
  'icims.com',
  'teamtailor.com',
  'recruitee.com',
  'breezy.hr',
  'workable.com',
  'smartrecruiters.com',
];

// Leading subdomain/mailbox labels that are generic plumbing, not a company.
const GENERIC_LABELS = new Set([
  'no-reply', 'noreply', 'do-not-reply', 'donotreply', 'jobs', 'job', 'mail',
  'email', 'careers', 'career', 'recruiting', 'recruitment', 'notifications',
  'notification', 'hire', 'apply', 'talent', 'hello', 'info', 'hr', 'us', 'eu',
  'app', 'mailer', 'notify', 'team',
]);

// Patterns that reveal the company inside a subject line.
const COMPANY_SUBJECT_PATTERNS = [
  /appl(?:ication|ied|ying) (?:to|for|at|with) ([A-Z][\w&.,'-]*(?:\s+[A-Z][\w&.,'-]*){0,4})/,
  /application (?:to|for|at) ([A-Z][\w&.,'-]*(?:\s+[A-Z][\w&.,'-]*){0,4})/,
  /(?:your|the) (?:application|interest) (?:in|with) ([A-Z][\w&.,'-]*(?:\s+[A-Z][\w&.,'-]*){0,4})/,
  /at ([A-Z][\w&.,'-]*(?:\s+[A-Z][\w&.,'-]*){0,3})[!.,]?$/,
  /\bfrom ([A-Z][\w&.,'-]*(?:\s+[A-Z][\w&.,'-]*){0,3})\b/,
  /^([A-Z][\w&.,'-]*(?:\s+[A-Z][\w&.,'-]*){0,3}) (?:careers|recruiting|talent|hiring)/i,
];

// Patterns that reveal a role/title.
const ROLE_PATTERNS = [
  /(?:for|the) (?:the )?((?:senior|junior|staff|lead|principal|sr\.?|jr\.?)?\s*[A-Za-z]+(?:\s+[A-Za-z]+){0,3}\s+(?:engineer|developer|designer|manager|analyst|scientist|architect|consultant|intern|specialist|lead))\b/i,
  /((?:senior|junior|staff|lead|principal|sr\.?|jr\.?)?\s*[A-Za-z]+(?:\s+[A-Za-z]+){0,3}\s+(?:engineer|developer|designer|manager|analyst|scientist|architect|consultant|intern|specialist))\s+(?:position|role|opening)/i,
];

function extractName(fromHeader = '') {
  // "Acme Talent <no-reply@acme.com>" -> "Acme Talent"
  const m = String(fromHeader).match(/^\s*"?([^"<]+?)"?\s*</);
  return m ? m[1].trim() : '';
}

// For "acme.greenhouse.io" style senders, return "Acme"; otherwise ''.
function companyFromAtsSubdomain(domain) {
  const host = ATS_SUBDOMAIN_HOSTS.find((h) => domain.endsWith('.' + h));
  if (!host) return '';
  const prefix = domain.slice(0, domain.length - host.length - 1); // drop ".host"
  if (!prefix) return '';
  const label = prefix.split('.')[0]; // leftmost label is the company slug
  if (!label || GENERIC_LABELS.has(label.toLowerCase())) return '';
  return titleCase(label);
}

/**
 * @param {{subject?:string, from?:string, snippet?:string}} email
 * @returns {{company:string, role:(string|null)}}
 */
function extract(email = {}) {
  const subject = (email.subject || '').toString();
  const from = (email.from || '').toString();
  const domain = domainOf(from);
  const isGeneric =
    GENERIC_SENDER_DOMAINS.some((d) => domain === d || domain.endsWith('.' + d)) || !domain;

  let company = '';

  // 1. Try to read the company out of the subject line.
  for (const pattern of COMPANY_SUBJECT_PATTERNS) {
    const m = subject.match(pattern);
    if (m && m[1]) {
      company = m[1].replace(/\s+(careers|recruiting|talent|hiring|team)$/i, '').trim();
      break;
    }
  }

  // 2. ATS subdomain (acme.greenhouse.io → Acme) — reliable when present.
  if (!company) {
    company = companyFromAtsSubdomain(domain);
  }

  // 3. If the sender is a real company domain, prefer that (very reliable).
  if (!company && !isGeneric) {
    company = companyFromDomain(domain);
  }

  // 3. Fall back to the sender display name (minus generic words).
  if (!company) {
    const name = extractName(from)
      .replace(/\b(careers|recruiting|recruitment|talent|hiring|team|no[- ]?reply|jobs|hr)\b/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (name && name.length > 1) company = name;
  }

  // 4. Last resort: the sender domain even if generic, or "Unknown".
  if (!company) company = domain ? companyFromDomain(domain) : 'Unknown';

  // Role extraction (best effort — often null).
  let role = null;
  for (const pattern of ROLE_PATTERNS) {
    const m = subject.match(pattern) || (email.snippet || '').match(pattern);
    if (m && m[1]) {
      role = m[1].replace(/\s+/g, ' ').trim();
      break;
    }
  }

  return { company: company.slice(0, 80), role: role ? role.slice(0, 80) : null };
}

module.exports = { extract, companyFromDomain, extractName };
