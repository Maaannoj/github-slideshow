'use strict';

/**
 * Aggregates a stream of classified emails into one record per application
 * (keyed by company + role), resolving the "current" status.
 */

const { classify, STAGES } = require('./classifier');
const { extract } = require('./extractor');

// Rank stages so we can compare "how far along" two signals are.
const STAGE_RANK = STAGES.reduce((acc, s, i) => ((acc[s] = i), acc), {});

function normalizeKey(str) {
  return String(str || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

/**
 * Decide the winning status between the current record and a new signal.
 *
 * Rules:
 *  - "rejected" and "offer" are terminal: once seen they stick, and the more
 *    recent of the two wins if both appear.
 *  - Otherwise the later pipeline stage wins; ties break on the newer email.
 */
function pickStatus(current, incoming) {
  if (!current) return incoming;
  const cTerminal = current.status === 'rejected' || current.status === 'offer';
  const iTerminal = incoming.status === 'rejected' || incoming.status === 'offer';

  if (cTerminal && iTerminal) {
    return incoming.date >= current.date ? incoming : current;
  }
  if (cTerminal) return current;
  if (iTerminal) return incoming;

  const cRank = STAGE_RANK[current.status] ?? -1;
  const iRank = STAGE_RANK[incoming.status] ?? -1;
  if (iRank > cRank) return incoming;
  if (iRank < cRank) return current;
  return incoming.date >= current.date ? incoming : current;
}

/**
 * @param {Array<{id?:string, subject?:string, from?:string, snippet?:string, body?:string, date?:number, threadId?:string}>} emails
 * @returns {Array<object>} one record per application, most-recently-active first
 */
function aggregate(emails = []) {
  const apps = new Map();

  for (const email of emails) {
    const result = classify(email);
    if (!result.isJobRelated || !result.status) continue;

    const { company, role } = extract(email);
    // Key on company only. A single application rarely names the role in every
    // email, so folding role into the key fragments one application into
    // several cards. Role is enriched below when any email reveals it.
    const key = normalizeKey(company);

    const date = Number(email.date) || 0;
    const signal = {
      status: result.status,
      date,
      confidence: result.confidence,
      subject: email.subject || '',
      emailId: email.id || null,
    };

    const existing = apps.get(key);
    if (!existing) {
      apps.set(key, {
        key,
        company,
        role: role || null,
        status: result.status,
        confidence: result.confidence,
        firstSeen: date,
        lastUpdate: date,
        emailCount: 1,
        latestSubject: email.subject || '',
        history: [signal],
      });
      continue;
    }

    existing.emailCount += 1;
    existing.history.push(signal);
    existing.firstSeen = Math.min(existing.firstSeen, date);
    // Enrich role once any email reveals it (prefer the earliest known one).
    if (!existing.role && role) existing.role = role;

    const winner = pickStatus(
      { status: existing.status, date: existing.lastUpdate },
      { status: result.status, date }
    );
    // Update status/confidence and the "last update" timestamp to the winner's.
    existing.status = winner.status;
    existing.lastUpdate = Math.max(existing.lastUpdate, date);
    if (date >= existing.lastUpdate - 1) {
      existing.latestSubject = email.subject || existing.latestSubject;
    }
    existing.confidence = Math.max(existing.confidence, result.confidence);
  }

  const records = [...apps.values()];
  for (const r of records) r.history.sort((a, b) => a.date - b.date);
  records.sort((a, b) => b.lastUpdate - a.lastUpdate);
  return records;
}

module.exports = { aggregate, pickStatus, normalizeKey };
