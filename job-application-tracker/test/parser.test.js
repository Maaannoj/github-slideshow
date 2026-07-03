'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { classify } = require('../src/main/parser/classifier');
const { extract } = require('../src/main/parser/extractor');
const { aggregate, pickStatus, diffStatuses } = require('../src/main/parser/aggregate');

test('classify: application confirmation → applied', () => {
  const r = classify({
    subject: 'Thank you for applying to Acme',
    from: 'Acme Careers <no-reply@acme.greenhouse.io>',
    snippet: 'We have received your application for the Backend Engineer role.',
  });
  assert.equal(r.status, 'applied');
  assert.equal(r.isJobRelated, true);
});

test('classify: interview invite → interview', () => {
  const r = classify({
    subject: 'Next steps: interview with the team',
    from: 'recruiting@lever.co',
    snippet: 'We would love to schedule a call to discuss the role.',
  });
  assert.equal(r.status, 'interview');
});

test('classify: rejection → rejected', () => {
  const r = classify({
    subject: 'Update on your application',
    from: 'talent@acme.com',
    snippet: 'Unfortunately, we have decided not to move forward with your application.',
  });
  assert.equal(r.status, 'rejected');
});

test('classify: offer → offer', () => {
  const r = classify({
    subject: 'Your offer from Acme',
    from: 'hr@acme.com',
    snippet: 'We are delighted to offer you the position of Senior Engineer.',
  });
  assert.equal(r.status, 'offer');
});

test('classify: "moving forward with other candidates" → rejected', () => {
  const r = classify({
    subject: 'Your application at Goldman Sachs',
    from: 'careers@gs.com',
    snippet: 'After careful consideration we have decided to move forward with other candidates.',
  });
  assert.equal(r.status, 'rejected');
});

test('classify: "will not be progressing" → rejected', () => {
  const r = classify({
    subject: 'Update on your candidacy',
    from: 'talent@company.com',
    snippet: 'We will not be progressing your application to the next stage.',
  });
  assert.equal(r.status, 'rejected');
});

test('classify: coding assessment → assessment', () => {
  const r = classify({
    subject: 'Complete your coding challenge',
    from: 'no-reply@hackerrank.com',
    snippet: 'Please complete the technical assessment within 5 days.',
  });
  assert.equal(r.status, 'assessment');
});

test('classify: forex order failure is NOT job-related', () => {
  const r = classify({
    subject: 'Unable to process Forex order - FX787386030583',
    from: 'noreply@bookmyforex.com',
    snippet: 'Unfortunately we were unable to process your forex order.',
  });
  assert.equal(r.isJobRelated, false);
});

test('classify: e-Visa notification is NOT job-related', () => {
  const r = classify({
    subject: '[No-Reply] Notification from Vietnam e-Visa',
    from: 'noreply@evisa.gov.vn',
    snippet: 'Your e-visa application has been received.',
  });
  assert.equal(r.isJobRelated, false);
});

test('classify: bank OTP is NOT job-related', () => {
  const r = classify({
    subject: 'Your OTP for transaction',
    from: 'alerts@hdfcbank.com',
    snippet: 'Your one-time password is 123456 for a payment of INR 5000.',
  });
  assert.equal(r.isJobRelated, false);
});

test('classify: real application via Keka is job-related', () => {
  const r = classify({
    subject: 'Application for Senior Executive - Category Operations received',
    from: 'Acme Retail via Keka <no-reply@kekamail.com>',
    snippet: 'Thank you for applying. Your application has been received.',
  });
  assert.equal(r.isJobRelated, true);
  assert.equal(r.status, 'applied');
});

test('classify: newsletter is not job-related', () => {
  const r = classify({
    subject: 'Your weekly deals are here',
    from: 'deals@shopping.com',
    snippet: 'Save 20% on electronics this week only.',
  });
  assert.equal(r.isJobRelated, false);
  assert.equal(r.status, null);
});

test('extract: company from subject "application to X"', () => {
  const { company } = extract({
    subject: 'Your application to Stripe has been received',
    from: 'jobs@greenhouse.io',
  });
  assert.match(company, /Stripe/);
});

test('extract: company from real sender domain', () => {
  const { company } = extract({
    subject: 'A quick note',
    from: 'Jane <jane@figma.com>',
  });
  assert.equal(company, 'Figma');
});

test('extract: job title is never used as the company', () => {
  const { company, role } = extract({
    subject: 'Your recent job application for Manager - Project Implementation',
    from: 'no-reply@kekamail.com',
  });
  assert.notEqual(company.toLowerCase(), 'manager');
  assert.equal(company, 'Unknown company');
});

test('extract: "Company via ATS" display name yields the company', () => {
  const { company } = extract({
    subject: 'Application received',
    from: 'Stripe via Greenhouse <no-reply@greenhouse.io>',
  });
  assert.match(company, /Stripe/);
});

test('extract: country name is never the company', () => {
  const { company } = extract({
    subject: 'Notification from Vietnam',
    from: 'Vietnam <no-reply@service.vn>',
  });
  assert.notEqual(company.toLowerCase(), 'vietnam');
});

test('extract: role detection', () => {
  const { role } = extract({
    subject: 'Application for the Senior Backend Engineer position',
    from: 'jobs@acme.com',
  });
  assert.ok(role && /Engineer/i.test(role));
});

test('pickStatus: later stage wins', () => {
  const w = pickStatus({ status: 'applied', date: 1 }, { status: 'interview', date: 2 });
  assert.equal(w.status, 'interview');
});

test('pickStatus: terminal offer sticks over earlier interview', () => {
  const w = pickStatus({ status: 'offer', date: 5 }, { status: 'interview', date: 6 });
  assert.equal(w.status, 'offer');
});

test('aggregate: groups a multi-email pipeline into one record at latest stage', () => {
  const emails = [
    {
      id: '1',
      subject: 'Thanks for applying to Acme',
      from: 'jobs@acme.greenhouse.io',
      snippet: 'We received your application',
      date: 1000,
    },
    {
      id: '2',
      subject: 'Interview with Acme',
      from: 'jobs@acme.greenhouse.io',
      snippet: 'Let us schedule a call',
      date: 2000,
    },
    {
      id: '3',
      subject: 'Your application to Globex',
      from: 'no-reply@globex.lever.co',
      snippet: 'application received',
      date: 1500,
    },
  ];
  const apps = aggregate(emails);
  assert.equal(apps.length, 2);
  const acme = apps.find((a) => /acme/i.test(a.company));
  assert.ok(acme, 'Acme record exists');
  assert.equal(acme.status, 'interview');
  assert.equal(acme.emailCount, 2);
  // sorted most-recent first
  assert.equal(apps[0].company, acme.company);
});

test('aggregate: manual override wins over detected status and is kept', () => {
  const emails = [
    { id: '1', subject: 'Thanks for applying to Acme', from: 'jobs@acme.com', snippet: 'received your application', date: 1000 },
  ];
  const overrides = { acme: { manualStatus: 'interview', notes: 'call fri', pinned: true } };
  const [app] = aggregate(emails, overrides);
  assert.equal(app.autoStatus, 'applied');
  assert.equal(app.status, 'interview');
  assert.equal(app.manualStatus, 'interview');
  assert.equal(app.notes, 'call fri');
  assert.equal(app.pinned, true);
});

test('aggregate: reachedStages records every stage seen', () => {
  const emails = [
    { id: '1', subject: 'Thanks for applying to Globex', from: 'jobs@globex.com', snippet: 'received your application', date: 1000 },
    { id: '2', subject: 'Interview with Globex', from: 'jobs@globex.com', snippet: 'schedule a call', date: 2000 },
  ];
  const [app] = aggregate(emails);
  assert.ok(app.reachedStages.includes('applied'));
  assert.ok(app.reachedStages.includes('interview'));
});

test('diffStatuses: reports only notable new changes', () => {
  const prev = [{ key: 'acme', autoStatus: 'applied' }];
  const next = [
    { key: 'acme', company: 'Acme', autoStatus: 'interview' },
    { key: 'new', company: 'NewCo', autoStatus: 'applied' },
  ];
  const changes = diffStatuses(prev, next);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].company, 'Acme');
  assert.equal(changes[0].to, 'interview');
});

test('aggregate: rejection after interview marks rejected', () => {
  const emails = [
    {
      id: '1',
      subject: 'Interview with Initech',
      from: 'hr@initech.com',
      snippet: 'schedule a call',
      date: 1000,
    },
    {
      id: '2',
      subject: 'Update from Initech',
      from: 'hr@initech.com',
      snippet: 'Unfortunately we will not be moving forward',
      date: 2000,
    },
  ];
  const [app] = aggregate(emails);
  assert.equal(app.status, 'rejected');
});
