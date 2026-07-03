'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { classify } = require('../src/main/parser/classifier');
const { extract } = require('../src/main/parser/extractor');
const { aggregate, pickStatus } = require('../src/main/parser/aggregate');

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
