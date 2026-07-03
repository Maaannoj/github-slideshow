'use strict';

/**
 * Heuristic classifier that turns a raw email into a job-application signal.
 *
 * The module is deliberately free of any Gmail/Electron dependency so it can be
 * unit-tested in isolation and swapped for a smarter (e.g. LLM-backed) engine
 * later without touching the rest of the app.
 */

// Status stages ordered from earliest to latest. A later stage "wins" when an
// application accumulates emails across several stages (see aggregate.js).
const STAGES = ['applied', 'viewed', 'assessment', 'interview', 'offer', 'rejected'];

// Domains that are almost always Applicant Tracking Systems / job boards.
// Presence of one of these strongly implies the email is job-related.
const ATS_DOMAINS = [
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
  'ziprecruiter.com',
  'glassdoor.com',
  'wellfound.com',
  'hackerrank.com',
  'codility.com',
  'hackerearth.com',
  'calendly.com',
];

// Ordered rules. The FIRST matching rule (scanning latest stage first) decides
// the status, so more decisive signals (offer/rejected) are checked before
// generic ones (applied). Each pattern is matched case-insensitively against a
// combined "subject + snippet + from" haystack.
const RULES = [
  {
    status: 'rejected',
    patterns: [
      /unfortunately/,
      /we (?:have )?decided (?:not|to move forward with other)/,
      /not (?:be )?(?:moving|move|proceed(?:ing)?) forward/,
      /will not be moving forward/,
      /other candidate/,
      /regret to inform/,
      /not (?:been )?(?:selected|successful|shortlisted)/,
      /we(?:'| a)re unable to (?:offer|proceed|move)/,
      /position has been filled/,
      /pursue other candidate/,
      /no longer under consideration/,
      /decided to move (?:ahead|forward) with/,
      /move forward with (?:other|another|different)/,
      /decided to proceed with (?:other|another)/,
      /not (?:be )?progress(?:ing)? (?:your|with|to)/,
      /will not be progressing/,
      /unable to offer you/,
      /not to proceed with your application/,
      /chosen (?:other|another) candidate/,
      /filled this (?:position|role|vacancy)/,
    ],
  },
  {
    status: 'offer',
    patterns: [
      /pleased to (?:offer|extend)/,
      /job offer/,
      /offer (?:letter|of employment)/,
      /extend(?:ing)? (?:you )?an offer/,
      /we(?:'| a)re (?:excited|delighted) to offer/,
      /welcome (?:aboard|to the team)/,
      /congratulations.{0,40}offer/,
    ],
  },
  {
    status: 'interview',
    patterns: [
      /interview/,
      /phone screen/,
      /(?:schedule|book|set up) (?:a )?(?:call|time|chat|meeting|conversation)/,
      /(?:your|the) availability/,
      /would (?:love|like) to (?:chat|talk|speak|meet|connect)/,
      /next (?:step|round)/,
      /speak with (?:the|our) (?:team|hiring)/,
      /hiring manager would like/,
      /recruiter (?:call|screen)/,
      /calendly\.com/,
    ],
  },
  {
    status: 'assessment',
    patterns: [
      /(?:coding|technical|online) (?:challenge|assessment|test|exercise)/,
      /take[- ]home/,
      /hackerrank/,
      /codility/,
      /hackerearth/,
      /skills? (?:test|assessment)/,
      /complete (?:the|this|a) (?:assessment|challenge|test)/,
      /aptitude test/,
    ],
  },
  {
    status: 'viewed',
    patterns: [
      /application was viewed/,
      /viewed your application/,
      /your application (?:was|has been) (?:viewed|opened)/,
      /recruiter (?:viewed|looked at)/,
    ],
  },
  {
    status: 'applied',
    patterns: [
      /thank you for (?:your interest|applying|your application)/,
      /(?:we(?:'| ha)ve )?received your application/,
      /application (?:received|submitted|confirmation|complete)/,
      /successfully applied/,
      /your application (?:for|to)/,
      /applied to/,
      /we got your application/,
      /thanks for applying/,
    ],
  },
];

// Weaker signals that just mark an email as "job related" even if no stage rule
// fires. Used together with ATS_DOMAINS to decide whether to keep the email.
const JOB_KEYWORDS = [
  /application/,
  /\bapplied\b/,
  /\bposition\b/,
  /\bthe role\b/,
  /\bcandidacy\b/,
  /\bcandidate\b/,
  /\brecruit/,
  /\bhiring\b/,
  /\btalent (?:team|acquisition)\b/,
  /job (?:opening|posting|application)/,
];

function domainOf(fromHeader = '') {
  const match = String(fromHeader).match(/@([a-z0-9.-]+\.[a-z]{2,})/i);
  return match ? match[1].toLowerCase() : '';
}

function isAtsDomain(domain) {
  if (!domain) return false;
  return ATS_DOMAINS.some((d) => domain === d || domain.endsWith('.' + d));
}

/**
 * Classify a normalized email.
 * @param {{subject?:string, snippet?:string, from?:string, body?:string}} email
 * @returns {{isJobRelated:boolean, status:(string|null), confidence:number, reason:string}}
 */
function classify(email = {}) {
  const subject = (email.subject || '').toString();
  const snippet = (email.snippet || email.body || '').toString();
  const from = (email.from || '').toString();
  const domain = domainOf(from);
  const fromAts = isAtsDomain(domain);

  // Subject carries the most reliable signal, so weight it by scanning it first.
  const haystack = `${subject}\n${snippet}\n${from}`.toLowerCase();

  for (const rule of RULES) {
    for (const pattern of rule.patterns) {
      if (pattern.test(haystack)) {
        // An ATS/job-board sender or a job keyword raises our confidence that
        // this really is an application email and not a false positive.
        const supported = fromAts || JOB_KEYWORDS.some((k) => k.test(haystack));
        const confidence = supported ? 0.9 : 0.6;
        return {
          isJobRelated: true,
          status: rule.status,
          confidence,
          reason: `matched ${pattern} → ${rule.status}${fromAts ? ` (ATS: ${domain})` : ''}`,
        };
      }
    }
  }

  // No stage matched. It may still be job-related (e.g. a recruiter intro) if it
  // comes from an ATS domain or mentions job keywords — default such mail to
  // "applied" so the user still sees the company on their board.
  const keywordHit = JOB_KEYWORDS.some((k) => k.test(haystack));
  if (fromAts || keywordHit) {
    return {
      isJobRelated: true,
      status: 'applied',
      confidence: fromAts ? 0.55 : 0.35,
      reason: fromAts ? `ATS domain ${domain}, no stage matched` : 'job keyword, no stage matched',
    };
  }

  return { isJobRelated: false, status: null, confidence: 0, reason: 'no job signal' };
}

module.exports = { classify, STAGES, ATS_DOMAINS, domainOf, isAtsDomain };
