'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createGenerationsStore, MAX_GENERATIONS } = require('../lib/generations');

function tmpStore(options) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'generations-'));
  return createGenerationsStore(path.join(dir, 'generations.json'), options);
}

const base = {
  company: 'Entreprise',
  role: 'Poste',
  lang: 'en',
  format: 'ats',
  websiteMode: 'show',
  jobOffer: "Le texte de l'offre.",
};

test('reading before anything was ever generated returns an empty list', () => {
  const store = tmpStore();
  assert.deepEqual(store.readGenerations(), []);
  assert.deepEqual(store.listGenerations(), []);
  assert.equal(store.getGeneration('nope'), null);
});

test('a generation is stored with its offer and read back whole', async () => {
  const store = tmpStore();
  const entry = await store.addGeneration({
    ...base,
    analysis: { role_title: 'Poste' },
    rewrite: { summary_rewritten: 'Profil.' },
    pdfFilename: 'cv.pdf',
    pdfUrl: '/outputs/cv.pdf',
  });

  const stored = store.getGeneration(entry.id);
  assert.equal(stored.jobOffer, base.jobOffer);
  assert.equal(stored.lang, 'en');
  assert.equal(stored.format, 'ats');
  assert.equal(stored.websiteMode, 'show');
  assert.deepEqual(stored.rewrite, { summary_rewritten: 'Profil.' });
  assert.equal(stored.pdfUrl, '/outputs/cv.pdf');
});

test('a generation without an offer is refused, not silently stored', async () => {
  const store = tmpStore();
  await assert.rejects(() => store.addGeneration({ ...base, jobOffer: '   ' }), /jobOffer/);
  assert.deepEqual(store.readGenerations(), []);
});

test('the history keeps the newest first and never grows past its cap', async () => {
  const store = tmpStore({ max: 3 });
  for (const role of ['A', 'B', 'C', 'D']) {
    await store.addGeneration({ ...base, role, jobOffer: `Offre ${role}` });
  }

  const list = store.listGenerations();
  assert.equal(list.length, 3);
  assert.deepEqual(list.map((g) => g.role), ['D', 'C', 'B']);
});

test('the default cap is 10', async () => {
  const store = tmpStore();
  for (let i = 0; i < 12; i++) {
    await store.addGeneration({ ...base, role: `Poste ${i}` });
  }
  assert.equal(store.listGenerations().length, MAX_GENERATIONS);
});

test('the list view carries no offer or payload, the detail view does', async () => {
  const store = tmpStore();
  await store.addGeneration({ ...base, analysis: { score: 60 }, rewrite: { a: 1 } });

  const [summary] = store.listGenerations();
  assert.equal(summary.jobOffer, undefined);
  assert.equal(summary.analysis, undefined);
  assert.equal(summary.rewrite, undefined);
  assert.equal(summary.role, 'Poste');
  assert.equal(store.getGeneration(summary.id).jobOffer, base.jobOffer);
});

test('a corrupt history file reads as empty rather than breaking a generation', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'generations-'));
  const file = path.join(dir, 'generations.json');
  fs.writeFileSync(file, '{ not json');
  assert.deepEqual(createGenerationsStore(file).readGenerations(), []);
});
