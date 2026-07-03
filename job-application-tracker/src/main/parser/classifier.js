'use strict';

/**
 * Strict heuristic classifier that turns a raw email into a job-application
 * signal. Gated in three passes:
 *   1. HARD NEGATIVE  — transactional / visa / banking / travel / marketing mail
 *      is rejected outright (unless it comes from a known ATS).
 *   2. POSITIVE GATE  — the mail must carry a genuine hiring signal (an ATS
 *      sender, or a strong application/interview/offer/rejection phrase, or the
 *      "application" keyword *with* hiring context).
 *   3. STAGE          — only mail that passes the gate is assigned a stage.
 *
 * The module has no Gmail/Electron dependency so it is unit-testable and can be
 * swapped for an LLM-backed engine later.
 */

const STAGES = ['applied', 'viewed', 'assessment', 'interview', 'offer', 'rejected'];

// Domains that are almost always Applicant Tracking Systems / job boards.
// Mail from these is trusted as job-related and skips the negative filter.
const ATS_DOMAINS = [
  'greenhouse.io', 'lever.co', 'hire.lever.co', 'myworkday.com', 'myworkdayjobs.com',
  'ashbyhq.com', 'smartrecruiters.com', 'workable.com', 'jobvite.com', 'icims.com',
  'taleo.net', 'bamboohr.com', 'breezy.hr', 'recruitee.com', 'teamtailor.com',
  'successfactors.com', 'eightfold.ai', 'phenompeople.com', 'avature.net', 'oraclecloud.com',
  'paylocity.com', 'dayforcehcm.com', 'hackerrank.com', 'codility.com', 'hackerearth.com',
  'linkedin.com', 'indeed.com', 'indeedemail.com', 'ziprecruiter.com', 'glassdoor.com',
  'wellfound.com', 'linkedin.com', 'calendly.com',
  // India-focused ATS / job boards (the user's mail shows several).
  'naukri.com', 'foundit.in', 'monsterindia.com', 'instahyre.com', 'hirist.com',
  'cutshort.io', 'zohorecruit.com', 'freshteam.com', 'darwinbox.com', 'darwinbox.in',
  'keka.com', 'kekamail.com', 'peoplestrong.com', 'iimjobs.com', 'apna.co',
  'timesjobs.com', 'shine.com', 'ripplehire.com', 'smartrecruiters.com',
];

// HARD NEGATIVE: if a NON-ATS email matches any of these, it is not a job
// application, full stop. This is what removes forex orders, e-visas, receipts,
// OTPs, shipping and marketing mail that merely contain the word "application".
const HARD_NEGATIVE = [
  /\be-?visa\b/, /\bvisa (?:application|approval|fee|slot|appointment)\b/, /\bpassport\b/,
  /\bimmigration\b/, /\bembassy\b/, /\bconsulate\b/, /\betihad|emirates|airlines?\b/,
  /\bforex\b/, /\bforeign exchange\b/, /\bcurrency\b/, /\bremittance\b/, /\bwire transfer\b/,
  /\border (?:number|confirmation|id|#|placed|failed|cancelled)\b/, /\bunable to process\b/,
  /\binvoice\b/, /\breceipt\b/, /\brefund\b/, /\bpayment (?:received|failed|due|successful|link)\b/,
  /\btransaction\b/, /\bemi\b/, /\bloan\b/, /\bcredit card\b/, /\bdebit\b/, /\bwallet\b/,
  /\baccount statement\b/, /\bmin(?:imum)? (?:amount )?due\b/, /\bkyc\b/,
  /\botp\b/, /\bone[- ]time (?:password|passcode)\b/, /\bverification code\b/,
  /\bverify your (?:email|account|phone|mobile|number)\b/, /\bconfirm your (?:email|subscription)\b/,
  /\bbooking\b/, /\breservation\b/, /\bitinerary\b/, /\bcheck[- ]in\b/, /\bboarding pass\b/,
  /\bflight\b/, /\bhotel\b/, /\btracking (?:number|id)\b/, /\bout for delivery\b/, /\bshipped\b/,
  /\bdelivered\b/, /\byour parcel\b/, /\bunsubscribe from\b/, /\bwebinar\b/, /\bnewsletter\b/,
  /\b\d+% off\b/, /\bflat \d+% \b/, /\bsale ends\b/, /\blimited time offer\b/, /\bcoupon\b/,
  /\bcashback\b/, /\brecharge\b/, /\bsubscription (?:renew|expir|confirm)/, /\bfree trial\b/,
  /\bgift card\b/, /\bwarranty\b/, /\bpolicy (?:renewal|number|premium)\b/, /\binsurance\b/,
];

// STRONG job phrases — any one of these is enough to treat mail as job-related.
const STRONG_JOB = [
  /thank you for (?:applying|your application)/, /thanks for applying/,
  /(?:we(?:'| ha)ve )?received your application/, /your application (?:for|to|has been|was|is)/,
  /application (?:for|to) the (?:position|role|job)/, /the (?:position|role) of\b/,
  /your candidacy/, /your recent (?:job )?application/, /status of your application/,
  /(?:hiring|recruit(?:ing|ment)|talent acquisition|talent) team/,
  /(?:phone|technical|onsite|final|first|hr) (?:interview|screen|round)/,
  /invite you to (?:an )?interview/, /schedule (?:an|your|a time for the) interview/,
  /move forward with your application/, /we regret to inform you/,
  /pleased to (?:offer|extend you)/, /offer of employment/, /your offer (?:letter|from)/,
  /completed the (?:coding|technical) (?:challenge|assessment)/,
  /application (?:received|submitted|under review|has been reviewed)/,
  /thank you for your interest in (?:the|our|joining|working)/,
];

// WEAK signals — accepted only together with hiring CONTEXT and no negative.
const WEAK_JOB = [/\bapplication\b/, /\bapplied\b/, /\bcandidate\b/, /\bcandidacy\b/];
const HIRING_CONTEXT = [
  /\bposition\b/, /\brole\b/, /\bvacancy\b/, /\bopening\b/, /\bjob\b/, /\bhiring\b/,
  /\brecruit/, /\bcareers?\b/, /\bemployment\b/, /\binterview\b/, /\bresume\b/, /\bcv\b/,
  /\bhiring manager\b/, /\btalent\b/,
];

// STAGE rules, most-decisive first.
const RULES = [
  {
    status: 'rejected',
    patterns: [
      /we regret to inform/, /not (?:be )?(?:moving|move|proceed(?:ing)?) forward/,
      /will not be (?:moving|progressing)/, /move forward with (?:other|another|different)/,
      /(?:other|another) candidate/, /not (?:been )?(?:selected|successful|shortlisted)/,
      /unable to offer you/, /position has been filled/, /filled this (?:position|role|vacancy)/,
      /decided (?:not to proceed|to proceed with other|to move forward with other)/,
      /no longer under consideration/, /not to proceed with your application/,
      /unfortunately,? (?:we|after|your|the)/, /pursue other candidate/,
      /chosen (?:other|another) candidate/, /not be progress/,
    ],
  },
  {
    status: 'offer',
    patterns: [
      /pleased to (?:offer|extend you)/, /job offer/, /offer (?:letter|of employment)/,
      /extend(?:ing)? (?:you )?an offer/, /we(?:'| a)re (?:excited|delighted|thrilled) to offer/,
      /welcome (?:aboard|to the team)/, /congratulations.{0,60}(?:offer|position|role)/,
    ],
  },
  {
    status: 'interview',
    patterns: [
      /\binterview\b/, /phone screen/, /(?:schedule|book|set up) (?:a )?(?:call|time|chat|meeting|conversation|slot)/,
      /(?:your|the) availability/, /would (?:love|like) to (?:chat|talk|speak|meet|connect)/,
      /next (?:step|round)/, /speak with (?:the|our) (?:team|hiring)/,
      /hiring manager would like/, /recruiter (?:call|screen)/, /calendly\.com/,
    ],
  },
  {
    status: 'assessment',
    patterns: [
      /(?:coding|technical|online) (?:challenge|assessment|test|exercise)/, /take[- ]home/,
      /hackerrank/, /codility/, /hackerearth/, /skills? (?:test|assessment)/,
      /complete (?:the|this|a) (?:assessment|challenge|test)/, /aptitude test/,
    ],
  },
  {
    status: 'viewed',
    patterns: [
      /application was viewed/, /viewed your application/,
      /your application (?:was|has been) (?:viewed|opened)/, /recruiter (?:viewed|looked at)/,
    ],
  },
  {
    status: 'applied',
    patterns: [
      /thank you for (?:your interest|applying|your application)/,
      /(?:we(?:'| ha)ve )?received your application/,
      /application (?:received|submitted|confirmation|complete|under review)/,
      /successfully applied/, /your application (?:for|to)/, /applied to/,
      /we got your application/, /thanks for applying/,
    ],
  },
];

function domainOf(fromHeader = '') {
  const m = String(fromHeader).match(/@([a-z0-9.-]+\.[a-z]{2,})/i);
  return m ? m[1].toLowerCase() : '';
}
function isAtsDomain(domain) {
  if (!domain) return false;
  return ATS_DOMAINS.some((d) => domain === d || domain.endsWith('.' + d));
}
const anyMatch = (patterns, text) => patterns.some((p) => p.test(text));

/**
 * @param {{subject?:string, snippet?:string, from?:string, body?:string}} email
 * @returns {{isJobRelated:boolean, status:(string|null), confidence:number, reason:string}}
 */
function classify(email = {}) {
  const subject = (email.subject || '').toString();
  const snippet = (email.snippet || email.body || '').toString();
  const from = (email.from || '').toString();
  const domain = domainOf(from);
  const fromAts = isAtsDomain(domain);
  const hay = `${subject}\n${snippet}\n${from}`.toLowerCase();

  const reject = (reason) => ({ isJobRelated: false, status: null, confidence: 0, reason });

  // Pass 1 — hard negative (skipped for trusted ATS senders).
  if (!fromAts && anyMatch(HARD_NEGATIVE, hay)) return reject('hard-negative filter');

  // Pass 2 — find the stage. A "decisive" stage (a clear rejection / offer /
  // interview / assessment phrase) is itself proof the mail is job-related.
  let status = null;
  for (const rule of RULES) {
    if (anyMatch(rule.patterns, hay)) {
      status = rule.status;
      break;
    }
  }
  const decisive = status && status !== 'applied' && status !== 'viewed';

  // Pass 3 — positive gate.
  const strong = anyMatch(STRONG_JOB, hay);
  const weak = anyMatch(WEAK_JOB, hay) && anyMatch(HIRING_CONTEXT, hay);
  const isJobRelated = fromAts || strong || weak || decisive;
  if (!isJobRelated) return reject('no hiring signal');

  if (!status) status = 'applied'; // job-related but no explicit stage → applied

  // Confidence: ATS + strong phrase is very high; a lone weak/decisive hit lower.
  let confidence = 0.55;
  if (fromAts && strong) confidence = 0.95;
  else if (fromAts || strong) confidence = 0.85;
  else if (decisive) confidence = 0.7;
  else if (weak) confidence = 0.6;

  return {
    isJobRelated: true,
    status,
    confidence,
    reason: `${fromAts ? 'ats ' : ''}${strong ? 'strong ' : decisive ? 'decisive ' : weak ? 'weak ' : ''}→ ${status}`,
  };
}

module.exports = { classify, STAGES, ATS_DOMAINS, HARD_NEGATIVE, domainOf, isAtsDomain };
