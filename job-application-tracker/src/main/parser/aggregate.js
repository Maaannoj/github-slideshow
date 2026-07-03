'use strict';

/**
 * Aggregates a stream of classified emails into one record per application
 * (keyed by company), resolving the "current" status and merging any persisted
 * user overrides (manual status, notes, pin, archive).
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
 * @param {Array<object>} emails normalized emails
 * @param {Object<string,object>} [overrides] per-application user overrides keyed
 *        by normalized company: { manualStatus, notes, archived, pinned }
 * @returns {Array<object>} one record per application, most-recently-active first
 */
function aggregate(emails = [], overrides = {}) {
  const apps = new Map();

  for (const email of emails) {
    const result = classify(email);
    if (!result.isJobRelated || !result.status) continue;

    const { company, role } = extract(email);
    // Key on company only. A single application rarely names the role in every
    // email, so folding role into the key fragments one application into
    // several cards. Role is enriched below when any email reveals it.
    let key = normalizeKey(company);
    // "Unknown company" emails must NOT all collapse into one card — key them by
    // thread so replies group but unrelated unknowns stay separate.
    if (!key || key === 'unknowncompany') {
      key = 'unknown-' + (email.threadId || email.id || Math.random().toString(36).slice(2));
    }

    const date = Number(email.date) || 0;
    const signal = {
      status: result.status,
      date,
      confidence: result.confidence,
      subject: email.subject || '',
      emailId: email.id || null,
      threadId: email.threadId || null,
    };

    const existing = apps.get(key);
    if (!existing) {
      apps.set(key, {
        key,
        company,
        role: role || null,
        autoStatus: result.status,
        confidence: result.confidence,
        firstSeen: date,
        lastUpdate: date,
        emailCount: 1,
        latestSubject: email.subject || '',
        latestThreadId: signal.threadId,
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
      { status: existing.autoStatus, date: existing.lastUpdate },
      { status: result.status, date }
    );
    existing.autoStatus = winner.status;
    if (date >= existing.lastUpdate) {
      existing.lastUpdate = date;
      existing.latestSubject = email.subject || existing.latestSubject;
      existing.latestThreadId = signal.threadId || existing.latestThreadId;
    }
    existing.confidence = Math.max(existing.confidence, result.confidence);
  }

  // Confidence floor — drop anything that only ever matched the weakest signal.
  const MIN_CONFIDENCE = 0.5;
  const records = [...apps.values()].filter((r) => r.confidence >= MIN_CONFIDENCE);
  for (const r of records) {
    r.history.sort((a, b) => a.date - b.date);

    // Furthest pipeline stage this application ever reached (for the funnel).
    let furthest = -1;
    const reached = new Set();
    for (const h of r.history) {
      reached.add(h.status);
      furthest = Math.max(furthest, STAGE_RANK[h.status] ?? -1);
    }
    r.reachedStages = [...reached];
    r.furthestStage = STAGES[furthest] || r.autoStatus;

    // Merge persisted user override. A manual status wins over the detected one.
    const ov = overrides[r.key] || {};
    r.notes = ov.notes || '';
    r.archived = !!ov.archived;
    r.pinned = !!ov.pinned;
    r.manualStatus = ov.manualStatus || null;
    r.status = ov.manualStatus || r.autoStatus;
  }

  // Pinned first, then most recently active.
  records.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.lastUpdate - a.lastUpdate;
  });
  return records;
}

/**
 * Compare two application lists and return the meaningful status changes
 * (used to fire desktop notifications after a sync).
 * @returns {Array<{company:string, from:(string|null), to:string}>}
 */
function diffStatuses(previous = [], next = []) {
  const prevMap = new Map(previous.map((a) => [a.key, a.autoStatus || a.status]));
  const notable = new Set(['assessment', 'interview', 'offer', 'rejected']);
  const changes = [];
  for (const app of next) {
    const before = prevMap.get(app.key) || null;
    const after = app.autoStatus || app.status;
    if (after !== before && notable.has(after)) {
      changes.push({ company: app.company, from: before, to: after });
    }
  }
  return changes;
}

module.exports = { aggregate, pickStatus, normalizeKey, diffStatuses };
