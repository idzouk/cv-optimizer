'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { validateMasterCv, createMasterCvStore, groundMissingKeywords, stripFixedMarkers, buildMasterCvText } = require('../lib/masterCv');

function validCv() {
  return {
    personal: { name: 'Camille Rivet', email: 'camille@example.com', phone: '0600000000', location: 'Paris' },
    profil: 'Profil.',
    experiences: [{ id: 'exp1', titre: 'Consultant', realisations: ['Réalisation 1'] }],
    competences: ['Compétence A'],
    projets: [],
  };
}

test('validateMasterCv: accepts a minimally valid CV', () => {
  assert.deepEqual(validateMasterCv(validCv()), []);
});

test('validateMasterCv: rejects a non-object payload', () => {
  assert.deepEqual(validateMasterCv(null), ['Le contenu doit être un objet JSON.']);
  assert.deepEqual(validateMasterCv([1, 2, 3]), ['Le contenu doit être un objet JSON.']);
});

test('validateMasterCv: rejects missing personal fields', () => {
  const cv = validCv();
  delete cv.personal.email;
  const errors = validateMasterCv(cv);
  assert.ok(errors.some((e) => e.includes('personal.email')));
});

test('validateMasterCv: rejects empty or missing experiences', () => {
  const cv = validCv();
  cv.experiences = [];
  assert.ok(validateMasterCv(cv).some((e) => e.includes('experiences')));

  delete cv.experiences;
  assert.ok(validateMasterCv(cv).some((e) => e.includes('experiences')));
});

test('validateMasterCv: rejects duplicate experience ids', () => {
  const cv = validCv();
  cv.experiences.push({ id: 'exp1', titre: 'Doublon', realisations: [] });
  const errors = validateMasterCv(cv);
  assert.ok(errors.some((e) => e.includes('en double')));
});

test('validateMasterCv: rejects an experience missing realisations', () => {
  const cv = validCv();
  delete cv.experiences[0].realisations;
  const errors = validateMasterCv(cv);
  assert.ok(errors.some((e) => e.includes('realisations')));
});

test('validateMasterCv: rejects a project with an invalid type', () => {
  const cv = validCv();
  cv.projets = [{ id: 'p1', type: 'autre', nom: 'X', description: 'Y' }];
  const errors = validateMasterCv(cv);
  assert.ok(errors.some((e) => e.includes('projets[0].type')));
});

test('validateMasterCv: rejects a "conseil" project missing realisations', () => {
  const cv = validCv();
  cv.projets = [{ id: 'p1', type: 'conseil', nom: 'X' }];
  const errors = validateMasterCv(cv);
  assert.ok(errors.some((e) => e.includes('projets[0].realisations')));
});

test('validateMasterCv: rejects duplicate project ids', () => {
  const cv = validCv();
  cv.projets = [
    { id: 'p1', type: 'build', nom: 'X', description: 'Y' },
    { id: 'p1', type: 'build', nom: 'Z', description: 'W' },
  ];
  const errors = validateMasterCv(cv);
  assert.ok(errors.some((e) => e.includes('en double')));
});

test('writeMasterCv: writes atomically and leaves no temp file behind', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cv-optimizer-test-'));
  const masterCvPath = path.join(dir, 'master-cv.json');
  await fsp.writeFile(masterCvPath, JSON.stringify(validCv()), 'utf8');

  const { writeMasterCv, readMasterCvRaw } = createMasterCvStore(masterCvPath);
  const updated = { ...validCv(), profil: 'Profil mis à jour.' };
  await writeMasterCv(updated);

  assert.equal(readMasterCvRaw().profil, 'Profil mis à jour.');
  const leftovers = fs.readdirSync(dir).filter((f) => f.includes('.tmp'));
  assert.deepEqual(leftovers, []);

  await fsp.rm(dir, { recursive: true, force: true });
});

test('store: reads the example while master-cv.json is missing, and the first save creates it', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cv-optimizer-test-'));
  const masterCvPath = path.join(dir, 'master-cv.json');
  const examplePath = path.join(dir, 'master-cv.example.json');
  const example = validCv();
  await fsp.writeFile(examplePath, JSON.stringify(example), 'utf8');

  const store = createMasterCvStore(masterCvPath, { fallbackPath: examplePath });
  assert.equal(store.activeMasterCvPath(), examplePath);
  assert.deepEqual(store.readMasterCvRaw(), example);

  await store.writeMasterCv({ ...example, profil: 'Mon propre profil.' });
  assert.equal(store.activeMasterCvPath(), masterCvPath);
  assert.equal(store.readMasterCvRaw().profil, 'Mon propre profil.');
  assert.deepEqual(JSON.parse(fs.readFileSync(examplePath, 'utf8')), example);

  await fsp.rm(dir, { recursive: true, force: true });
});

test('master-cv.example.json: passes validation', () => {
  const example = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'master-cv.example.json'), 'utf8'));
  assert.deepEqual(validateMasterCv(example), []);
});

test('writeMasterCv: rejects an invalid payload without touching the file', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cv-optimizer-test-'));
  const masterCvPath = path.join(dir, 'master-cv.json');
  const original = validCv();
  await fsp.writeFile(masterCvPath, JSON.stringify(original), 'utf8');

  const { writeMasterCv, readMasterCvRaw } = createMasterCvStore(masterCvPath);
  await assert.rejects(() => writeMasterCv({ personal: {} }));

  assert.deepEqual(readMasterCvRaw(), original);

  await fsp.rm(dir, { recursive: true, force: true });
});

test('titre: a [FIXE] candidate title is loaded clean and marked immutable', () => {
  const fixed = new Set();
  const cv = stripFixedMarkers({ titre: '[FIXE] AI Operator · Builder' }, fixed);
  assert.equal(cv.titre, 'AI Operator · Builder');
  assert.ok(fixed.has('titre'));
});

test('groundMissingKeywords: only keywords backed by a real master realisation stay recommendable', () => {
  const cv = {
    experiences: [{ id: 'brume', realisations: ['Déployé un agent IA pour le reporting client'] }],
    projets: [
      { id: 'hestia', type: 'conseil', realisations: ['Cadre de 28 indicateurs'] },
      { id: 'radar', type: 'build', description: 'Brief stratégique sourcé' },
    ],
  };
  const out = groundMissingKeywords(cv, {
    missing_keywords: [
      { mot_cle: 'AI deployment', source: 'brume/0' },
      { mot_cle: 'KPI framework', source: 'hestia/0' },
      { mot_cle: 'prototypage', source: 'radar' },
      { mot_cle: 'enterprise change management', source: 'brume/9' },
      { mot_cle: 'customer success', source: '' },
      { mot_cle: 'onboarding', source: 'hestia' },
      'mot-clé sans preuve',
    ],
    keyword_gaps: ['SaaS'],
  });
  assert.deepEqual(out.missing_keywords, ['AI deployment', 'KPI framework', 'prototypage']);
  assert.deepEqual(out.keyword_gaps, [
    'SaaS',
    'enterprise change management',
    'customer success',
    'onboarding',
    'mot-clé sans preuve',
  ]);
  assert.equal(out.missing_keywords_proof[0].preuve, 'Déployé un agent IA pour le reporting client');
});

test('buildMasterCvText: the "contexte" of a build project reaches the model', () => {
  const text = buildMasterCvText({
    personal: { name: 'N', email: 'e', phone: 'p', location: 'l', linkedin: 'li', website: 'w' },
    profil: 'Profil.',
    competences: [],
    experiences: [],
    projets: [
      { id: 'veille', type: 'build', nom: 'Radar Concurrents', sous_titre: 'Outil', description: 'Analyse de marque.', contexte: 'Seulement pour les offres marque.' },
    ],
    education: [],
    langues: [],
    outils: [],
    interets: [],
  });
  assert.match(text, /\[id: veille\] \[type: build\][^\n]*\n  contexte: Seulement pour les offres marque\./);
});
