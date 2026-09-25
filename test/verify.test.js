'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { overclaimTranslationFlags, verifyTranslation, runFactChecks } = require('../lib/verify');

/**
 * runFactChecks is the deterministic half of the trust layer (the other
 * half, semanticFactCheck, calls Claude and isn't unit-tested here). These
 * tests protect the two hard rules it enforces before anything reaches a
 * PDF: no number that isn't in the exact source line, no proper noun that
 * doesn't exist anywhere in the master CV.
 */
function makeCv() {
  return {
    personal: { name: 'Camille Rivet', email: 'camille@example.com' },
    profil: 'Consultant chez Hestia avec 18 sites de couverture.',
    profil_variants: [],
    competences: ['Gestion de projet'],
    experiences: [
      {
        id: 'exp1',
        titre: 'Consultant',
        entreprise: 'Hestia',
        realisations: ['Piloté 18 sites pour Hestia', 'Généré 12 rapports pour Veltra'],
      },
    ],
    education: [],
    langues: [],
    outils: [],
    projets: [],
    interets: [],
  };
}

function makeRewrite({ picked, summary }) {
  return {
    summary_rewritten: summary,
    _grounded: {
      experiences: [{ id: 'exp1', picked: [picked] }],
      skills: [],
    },
  };
}

test('no violation when a reformulation keeps the same facts as its source', () => {
  const cv = makeCv();
  const rewrite = makeRewrite({
    picked: {
      text: 'Piloté un portefeuille de 18 sites pour Hestia',
      sourceText: 'Piloté 18 sites pour Hestia',
      changed: true,
    },
    summary: cv.profil,
  });

  assert.deepEqual(runFactChecks(cv, rewrite), []);
});

test('flags a number the bullet source never stated', () => {
  const cv = makeCv();
  const rewrite = makeRewrite({
    picked: {
      text: 'Piloté 20 sites pour Hestia',
      sourceText: 'Piloté 18 sites pour Hestia',
      changed: true,
    },
    summary: cv.profil,
  });

  const violations = runFactChecks(cv, rewrite);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].kind, 'chiffre');
  assert.match(violations[0].detail, /20/);
});

test('flags a proper noun absent from the whole master CV', () => {
  const cv = makeCv();
  const rewrite = makeRewrite({
    picked: {
      text: 'Piloté 18 sites pour Korvel',
      sourceText: 'Piloté 18 sites pour Hestia',
      changed: true,
    },
    summary: cv.profil,
  });

  const violations = runFactChecks(cv, rewrite);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].kind, 'nom propre');
  assert.match(violations[0].detail, /Korvel/);
});

test('skips verbatim (unchanged) lines entirely, even if they would fail the check', () => {
  const cv = makeCv();
  const rewrite = makeRewrite({
    picked: {
      text: 'Piloté 999 pays pour Mars Inc',
      sourceText: 'Piloté 999 pays pour Mars Inc',
      changed: false,
    },
    summary: cv.profil,
  });

  assert.deepEqual(runFactChecks(cv, rewrite), []);
});

test('checks the profile against its own text, not the whole master CV', () => {
  const cv = makeCv();
  const rewrite = makeRewrite({
    picked: {
      text: 'Piloté 18 sites pour Hestia',
      sourceText: 'Piloté 18 sites pour Hestia',
      changed: false,
    },
    summary: 'Consultant ayant généré 120% de croissance chez Google.',
  });

  const violations = runFactChecks(cv, rewrite);
  assert.ok(violations.some((v) => v.ref === 'profil' && v.kind === 'chiffre' && /120/.test(v.detail)));
  assert.ok(violations.some((v) => v.ref === 'profil' && v.kind === 'nom propre' && /Google/.test(v.detail)));
});

test('flags a profile that fuses in a fact from a bullet, even though it exists in the master', () => {
  // "Veltra" and "12" are real content of the master (exp1's second
  // bullet) — legitimate for a bullet to reuse, but not for the profile,
  // whose only allowed source is the one angle it was built from.
  const cv = makeCv();
  const rewrite = makeRewrite({
    picked: { text: 'x', sourceText: 'x', changed: false },
    summary: 'Consultant ayant généré 12 rapports pour Veltra.',
  });
  rewrite._grounded.profil_angle = 'defaut';

  const violations = runFactChecks(cv, rewrite);
  assert.ok(violations.some((v) => v.ref === 'profil' && v.kind === 'nom propre' && /Veltra/.test(v.detail)));
});

test('checks the profile against its chosen angle, not the default profile', () => {
  const cv = makeCv();
  cv.profil_variants = [{ angle: 'conseil', texte: 'Consultant IA pour Hestia, 18 sites, budget de 2M€.' }];
  const rewrite = makeRewrite({
    picked: { text: 'x', sourceText: 'x', changed: false },
    summary: 'Consultant IA pour Hestia, avec un budget de 2M€.',
  });
  rewrite._grounded.profil_angle = 'conseil';

  assert.deepEqual(runFactChecks(cv, rewrite).filter((v) => v.ref === 'profil'), []);
});

test('overclaimTranslationFlags: "executive" for "direction" is flagged by code (Dust run 4)', () => {
  const master = 'Interlocuteur direct de décideurs seniors (marketing, direction).';
  const flags = overclaimTranslationFlags(
    [
      { ref: 'exp:brume:0', fr: 'Interlocuteur direct de décideurs seniors (marketing, direction).', en: 'Direct contact for senior decision-makers (marketing, executive).' },
      { ref: 'exp:brume:1', en: 'Direct contact for senior decision-makers (marketing, management).' },
    ],
    master
  );
  assert.deepEqual(flags.map((f) => f.ref), ['exp:brume:0']);
});

test('overclaimTranslationFlags: "exécution" in the master does not back "executive"', () => {
  const flags = overclaimTranslationFlags(
    [{ ref: 'exp:brume:1', en: 'Senior decision-makers (marketing, executive).' }],
    'Décideurs seniors (marketing, direction). Radar : pistes d\'exécution, risques.'
  );
  assert.deepEqual(flags.map((f) => f.ref), ['exp:brume:1']);
});

test('overclaimTranslationFlags: a term the master itself backs is not flagged', () => {
  const flags = overclaimTranslationFlags(
    [{ ref: 'exp:x:0', en: 'Presented to the executive committee.' }],
    'Restitution au comité exécutif.'
  );
  assert.deepEqual(flags, []);
});

test('verifyTranslation: code flags are kept even when the model finds nothing, or fails', async () => {
  const items = [{ ref: 'exp:brume:0', en: 'Contact for C-suite executives.' }];
  const quiet = await verifyTranslation({ masterText: 'décideurs (direction)', items }, async () => ({ problemes: [] }));
  assert.deepEqual(quiet.map((p) => p.ref), ['exp:brume:0']);
  const broken = await verifyTranslation({ masterText: 'décideurs (direction)', items }, async () => {
    throw new Error('api down');
  });
  assert.deepEqual(broken.map((p) => p.ref), ['exp:brume:0']);
});

test('overclaimTranslationFlags: "direct" never becomes "primary", "lead" or "main"', () => {
  const fr = 'Interlocuteur direct de décideurs seniors (marketing, direction) sur un portefeuille de 3 à 4 grands comptes.';
  const flag = (en) => overclaimTranslationFlags([{ ref: 'exp:brume:0', fr, en }], fr).map((f) => f.ref);
  assert.deepEqual(flag('Primary point of contact for senior decision-makers (marketing, management).'), ['exp:brume:0']);
  assert.deepEqual(flag('Lead contact for senior decision-makers.'), ['exp:brume:0']);
  assert.deepEqual(flag('Main point of contact for senior decision-makers.'), ['exp:brume:0']);
  assert.deepEqual(flag('Direct point of contact for senior decision-makers (marketing, management).'), []);
  // No "direct" in the French line: not this rule's business.
  assert.deepEqual(
    overclaimTranslationFlags([{ ref: 'skill:0', fr: 'Génération de leads', en: 'Lead generation' }], ''),
    []
  );
});
