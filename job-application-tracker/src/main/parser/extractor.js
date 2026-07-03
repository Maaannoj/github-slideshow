'use strict';

/**
 * Extracts a clean company name and (best-effort) role from an email. Pure and
 * unit-testable. The company stoplist is what stops job titles ("Manager"),
 * countries ("Vietnam") and mailer words ("no-reply") from being shown as the
 * company.
 */

const { domainOf } = require('./classifier');

const GENERIC_SENDER_DOMAINS = [
  'greenhouse.io', 'lever.co', 'hire.lever.co', 'myworkday.com', 'myworkdayjobs.com',
  'ashbyhq.com', 'smartrecruiters.com', 'workable.com', 'jobvite.com', 'icims.com',
  'taleo.net', 'bamboohr.com', 'breezy.hr', 'recruitee.com', 'teamtailor.com',
  'successfactors.com', 'eightfold.ai', 'phenompeople.com', 'avature.net', 'oraclecloud.com',
  'linkedin.com', 'indeed.com', 'indeedemail.com', 'ziprecruiter.com', 'glassdoor.com',
  'wellfound.com', 'hackerrank.com', 'codility.com', 'calendly.com', 'naukri.com',
  'foundit.in', 'monsterindia.com', 'instahyre.com', 'hirist.com', 'cutshort.io',
  'zohorecruit.com', 'freshteam.com', 'darwinbox.com', 'darwinbox.in', 'keka.com',
  'kekamail.com', 'peoplestrong.com', 'iimjobs.com', 'apna.co', 'timesjobs.com',
  'shine.com', 'ripplehire.com', 'gmail.com', 'googlemail.com', 'outlook.com',
  'hotmail.com', 'yahoo.com', 'protonmail.com', 'zoho.com',
];

const ATS_SUBDOMAIN_HOSTS = [
  'greenhouse.io', 'myworkday.com', 'myworkdayjobs.com', 'jobvite.com', 'icims.com',
  'teamtailor.com', 'recruitee.com', 'breezy.hr', 'workable.com', 'smartrecruiters.com',
  'zohorecruit.com', 'freshteam.com', 'darwinbox.com', 'darwinbox.in',
];

// Words that are NEVER a company name on their own.
const TITLE_WORDS = new Set([
  'manager', 'senior', 'junior', 'lead', 'principal', 'staff', 'associate', 'assistant',
  'executive', 'engineer', 'developer', 'designer', 'analyst', 'scientist', 'architect',
  'consultant', 'intern', 'internship', 'specialist', 'coordinator', 'administrator',
  'representative', 'officer', 'director', 'head', 'vp', 'president', 'supervisor',
  'accountant', 'operations', 'sales', 'marketing', 'finance', 'hr', 'product',
  'project', 'program', 'business', 'data', 'software', 'full', 'stack', 'frontend',
  'backend', 'trainee', 'graduate',
]);
const GENERIC_WORDS = new Set([
  'no-reply', 'noreply', 'no', 'reply', 'do-not-reply', 'donotreply', 'jobs', 'job',
  'careers', 'career', 'recruiting', 'recruitment', 'recruiter', 'talent', 'hiring',
  'team', 'notifications', 'notification', 'notify', 'updates', 'update', 'info',
  'hello', 'hi', 'support', 'admin', 'mailer', 'mail', 'email', 'hr', 'people',
  'application', 'applications', 'apply', 'candidate', 'the', 'via', 'account',
]);
// A small set of country / place words that showed up as false companies.
const PLACE_WORDS = new Set([
  'india', 'vietnam', 'usa', 'uk', 'singapore', 'canada', 'australia', 'germany',
  'france', 'dubai', 'uae', 'china', 'japan', 'indonesia', 'thailand', 'malaysia',
]);

function isBadCompany(name) {
  const n = String(name || '').trim().toLowerCase();
  if (!n || n.length < 2) return true;
  const words = n.split(/\s+/);
  // reject if every word is a title/generic/place word
  return words.every((w) => TITLE_WORDS.has(w) || GENERIC_WORDS.has(w) || PLACE_WORDS.has(w));
}

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
  const parts = domain.split('.');
  const idx = parts.length >= 2 ? parts.length - 2 : 0;
  return titleCase(parts[idx] || parts[0]);
}

function companyFromAtsSubdomain(domain) {
  const host = ATS_SUBDOMAIN_HOSTS.find((h) => domain.endsWith('.' + h));
  if (!host) return '';
  const prefix = domain.slice(0, domain.length - host.length - 1);
  if (!prefix) return '';
  const label = prefix.split('.')[0];
  if (!label || GENERIC_WORDS.has(label.toLowerCase())) return '';
  return titleCase(label);
}

function extractName(fromHeader = '') {
  const m = String(fromHeader).match(/^\s*"?([^"<]+?)"?\s*</);
  return m ? m[1].trim() : '';
}

const COMPANY_SUBJECT_PATTERNS = [
  /appl(?:ication|ied|ying) (?:to|for|at|with) ([A-Z][\w&.,'-]*(?:\s+[A-Z][\w&.,'-]*){0,4})/,
  /(?:your|the) (?:application|interest|candidacy) (?:in|with|at) ([A-Z][\w&.,'-]*(?:\s+[A-Z][\w&.,'-]*){0,4})/,
  /(?:position|role|opportunity) (?:at|with) ([A-Z][\w&.,'-]*(?:\s+[A-Z][\w&.,'-]*){0,4})/,
  /^([A-Z][\w&.,'-]*(?:\s+[A-Z][\w&.,'-]*){0,3}) (?:careers|recruiting|talent|hiring|is hiring)/i,
];

const ROLE_PATTERNS = [
  /(?:for|the|of|as)(?: the| a| an)? ((?:senior|junior|staff|lead|principal|sr\.?|jr\.?|associate|assistant)?\s*[A-Za-z][A-Za-z/&]*(?:\s+[A-Za-z][A-Za-z/&]*){0,3}\s+(?:engineer|developer|designer|manager|analyst|scientist|architect|consultant|intern|internship|specialist|lead|executive|officer|associate|coordinator|administrator|accountant|representative))\b/i,
  /\b((?:senior|junior|staff|lead|principal|sr\.?|jr\.?)?\s*[A-Za-z][A-Za-z/&]*(?:\s+[A-Za-z][A-Za-z/&]*){0,3}\s+(?:engineer|developer|designer|manager|analyst|scientist|architect|consultant|intern|specialist|executive))\b(?=.{0,30}(?:position|role|opening|application))/i,
];

/**
 * @param {{subject?:string, from?:string, snippet?:string}} email
 * @returns {{company:string, role:(string|null)}}
 */
function extract(email = {}) {
  const subject = (email.subject || '').toString();
  const from = (email.from || '').toString();
  const snippet = (email.snippet || '').toString();
  const domain = domainOf(from);
  const isGeneric =
    GENERIC_SENDER_DOMAINS.some((d) => domain === d || domain.endsWith('.' + d)) || !domain;

  let company = '';

  // 1. "Company via Greenhouse/Keka/…" display-name pattern.
  const name = extractName(from);
  const viaMatch = name.match(/^(.+?)\s+via\s+/i);
  if (viaMatch && !isBadCompany(viaMatch[1])) company = viaMatch[1].trim();

  // 2. Company from the subject line.
  if (!company) {
    for (const p of COMPANY_SUBJECT_PATTERNS) {
      const m = subject.match(p);
      if (m && m[1]) {
        const cand = m[1].replace(/\s+(careers|recruiting|talent|hiring|team)$/i, '').trim();
        if (!isBadCompany(cand)) {
          company = cand;
          break;
        }
      }
    }
  }

  // 3. ATS subdomain (acme.greenhouse.io → Acme).
  if (!company) company = companyFromAtsSubdomain(domain);

  // 4. A real (non-generic) sender domain.
  if (!company && !isGeneric) company = companyFromDomain(domain);

  // 5. Sender display name, cleaned, if it isn't a title/generic word.
  if (!company && name) {
    const cleaned = name
      .replace(/\bvia\b.*/i, '')
      .replace(/\b(careers|recruiting|recruitment|talent|hiring|team|no[- ]?reply|jobs|hr|notifications?)\b/gi, '')
      .replace(/[|,-].*$/, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (cleaned && !isBadCompany(cleaned)) company = cleaned;
  }

  // 6. Give up gracefully rather than showing a wrong guess.
  if (!company || isBadCompany(company)) company = 'Unknown company';

  // Role extraction (best-effort).
  let role = null;
  for (const p of ROLE_PATTERNS) {
    const m = subject.match(p) || snippet.match(p);
    if (m && m[1]) {
      const r = m[1].replace(/\s+/g, ' ').trim();
      if (r.length > 2 && !/^the$/i.test(r)) {
        role = r;
        break;
      }
    }
  }

  return { company: company.slice(0, 80), role: role ? role.slice(0, 80) : null };
}

module.exports = { extract, companyFromDomain, extractName, isBadCompany };
