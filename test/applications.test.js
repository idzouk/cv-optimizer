'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createApplicationsStore } = require('../lib/applications');

async function scratchStore() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cv-optimizer-apps-test-'));
  const applicationsPath = path.join(dir, 'applications.json');
  return { dir, store: createApplicationsStore(applicationsPath) };
}

test('readApplications: returns an empty list when the file does not exist yet', async () => {
  const { dir, store } = await scratchStore();
  assert.deepEqual(store.readApplications(), []);
  await fsp.rm(dir, { recursive: true, force: true });
});

test('addApplication: creates an entry with status "envoyee" and persists it', async () => {
  const { dir, store } = await scratchStore();
  const entry = await store.addApplication({
    company: 'Hestia',
    role: 'Consultant IA',
    pdfFilename: 'Camille_Rivet_Hestia.pdf',
    pdfUrl: '/outputs/Camille_Rivet_Hestia.pdf',
    lang: 'fr',
  });

  assert.equal(entry.company, 'Hestia');
  assert.equal(entry.status, 'envoyee');
  assert.ok(entry.id);
  assert.ok(entry.date);

  const list = store.readApplications();
  assert.equal(list.length, 1);
  assert.deepEqual(list[0], entry);

  await fsp.rm(dir, { recursive: true, force: true });
});

test('addApplication: rejects a missing pdfFilename without writing anything', async () => {
  const { dir, store } = await scratchStore();
  await assert.rejects(() => store.addApplication({ company: 'Hestia' }));
  assert.deepEqual(store.readApplications(), []);
  await fsp.rm(dir, { recursive: true, force: true });
});

test('addApplication: most recent application is listed first', async () => {
  const { dir, store } = await scratchStore();
  const first = await store.addApplication({ company: 'A', pdfFilename: 'a.pdf' });
  const second = await store.addApplication({ company: 'B', pdfFilename: 'b.pdf' });

  const list = store.readApplications();
  assert.equal(list[0].id, second.id);
  assert.equal(list[1].id, first.id);

  await fsp.rm(dir, { recursive: true, force: true });
});

test('updateApplication: moves an application to "refusee" or "acceptee"', async () => {
  const { dir, store } = await scratchStore();
  const entry = await store.addApplication({ company: 'Hestia', pdfFilename: 'x.pdf' });

  const updated = await store.updateApplication(entry.id, { status: 'refusee' });
  assert.equal(updated.status, 'refusee');
  assert.ok(updated.updatedAt);
  assert.equal(store.readApplications()[0].status, 'refusee');

  await fsp.rm(dir, { recursive: true, force: true });
});

test('updateApplication: rejects an invalid status', async () => {
  const { dir, store } = await scratchStore();
  const entry = await store.addApplication({ company: 'Hestia', pdfFilename: 'x.pdf' });
  await assert.rejects(() => store.updateApplication(entry.id, { status: 'en_entretien' }));
  await fsp.rm(dir, { recursive: true, force: true });
});

test('updateApplication: rejects an unknown id', async () => {
  const { dir, store } = await scratchStore();
  await assert.rejects(() => store.updateApplication('does-not-exist', { status: 'refusee' }));
  await fsp.rm(dir, { recursive: true, force: true });
});

test('updateApplication: sets and clears an interview date independently of status', async () => {
  const { dir, store } = await scratchStore();
  const entry = await store.addApplication({ company: 'Hestia', pdfFilename: 'x.pdf' });

  const withDate = await store.updateApplication(entry.id, { interviewDate: '2026-09-22' });
  assert.equal(withDate.interviewDate, '2026-09-22');
  assert.equal(withDate.status, 'envoyee'); // untouched — only interviewDate was passed

  const cleared = await store.updateApplication(entry.id, { interviewDate: null });
  assert.equal(cleared.interviewDate, null);

  await fsp.rm(dir, { recursive: true, force: true });
});

test('updateApplication: rejects a malformed interview date', async () => {
  const { dir, store } = await scratchStore();
  const entry = await store.addApplication({ company: 'Hestia', pdfFilename: 'x.pdf' });
  await assert.rejects(() => store.updateApplication(entry.id, { interviewDate: '22/09/2026' }));
  await fsp.rm(dir, { recursive: true, force: true });
});

test('addApplication: stores optional score and format fields', async () => {
  const { dir, store } = await scratchStore();
  const entry = await store.addApplication({
    company: 'Hestia',
    pdfFilename: 'x.pdf',
    scoreAvant: 62,
    scoreApres: 78,
    format: 'design',
  });
  assert.equal(entry.scoreAvant, 62);
  assert.equal(entry.scoreApres, 78);
  assert.equal(entry.format, 'design');

  await fsp.rm(dir, { recursive: true, force: true });
});

test("addApplication: garde l'offre avec la candidature, null quand elle n'est pas fournie", async () => {
  const { dir, store } = await scratchStore();

  const withOffer = await store.addApplication({
    pdfFilename: 'cv.pdf',
    jobOffer: "Texte de l'offre.",
  });
  assert.equal(withOffer.jobOffer, "Texte de l'offre.");
  assert.equal(store.readApplications()[0].jobOffer, "Texte de l'offre.");

  const without = await store.addApplication({ pdfFilename: 'cv2.pdf' });
  assert.equal(without.jobOffer, null);

  await fsp.rm(dir, { recursive: true, force: true });
});
