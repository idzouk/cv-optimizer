'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  translationItems,
  rejectDuplicateFixes,
  applyTranslationFixes,
  licenceIsRelevant,
  buildTranslationPayload,
  buildCvHtml,
  resolveDisplayProjects,
  applyProjectBudget,
  TRIM_PLAN,
  fitToOnePage,
  A4_HEIGHT_PX,
} = require('../lib/render');
const { pdfPageCount } = require('../lib/util');

const TEMPLATE_PATH = path.join(__dirname, '..', 'templates', 'cv-template.html');

/** Minimal CV with one linked project and one without. */
function makeCvForHtml() {
  return {
    personal: {
      name: 'Prenom Nom',
      email: 'a@b.c',
      phone: '+33000000000',
      location: 'Paris, Île-de-France',
      linkedin: 'linkedin.com/in/x',
      website: 'exemple.test',
      disponibilite: 'Disponible',
      age: '26 ans',
      permis: 'Permis B',
    },
    profil: 'Profil.',
    experiences: [
      {
        id: 'exp1',
        titre: 'Consultant',
        entreprise: 'Boite',
        periode: '2024',
        realisations: ['R1', 'R2', 'R3', 'R4'],
      },
    ],
    education: [{ diplome: 'Master', ecole: 'Ecole', periode: '2024', detail: '' }],
    competences: ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8'],
    outils: [{ label: 'Dev', valeur: 'Node.js' }],
    langues: [{ nom: 'Français', niveau: 'C2' }],
    interets: ['Intérêt A', 'Intérêt B'],
    projets: [
      {
        id: 'avec-lien',
        type: 'build',
        nom: 'Projet Lié',
        sous_titre: 'Application web',
        lien: 'https://exemple-projet.test',
        description: 'Description du projet lié.',
        description_courte: 'Version courte.',
      },
      {
        id: 'sans-lien',
        type: 'build',
        nom: 'Projet Sans Lien',
        sous_titre: 'Outil interne',
        description: 'Description du projet sans lien.',
      },
    ],
  };
}

function html(format, rewrite, trim) {
  return buildCvHtml(makeCvForHtml(), {
    trim,
    format,
    analysis: null,
    rewrite,
    lang: 'fr',
    translated: null,
    websiteMode: 'show',
    jobOffer: '',
    templatePath: TEMPLATE_PATH,
  });
}

/**
 * The post-translation check flattens the translated payload into refs and
 * applies repairs back through those same refs. If the two ever disagree, a
 * repaired line silently never reaches the PDF — so they are tested together.
 */
function makeTranslated() {
  return {
    profile: 'Consultant with two years in a media agency.',
    target_title: 'AI Solutions Engineer',
    skills: ['Paid social', 'Prompt engineering'],
    experiences: [
      { id: 'brume', title: 'Media Buyer', type: 'Apprenticeship', location: 'Paris', period: 'August 2024', bullets: ['Ran campaigns.', 'Reported weekly.'] },
    ],
    ai_projects: [
      { subtitle: 'Team consulting project', description: '', bullets: ['Designed a framework.'] },
      { subtitle: 'Personal web application', description: '5-step LLM pipeline.', bullets: [] },
    ],
  };
}

test('translationItems: covers every claim-carrying line, skips empties', () => {
  const refs = translationItems(makeTranslated()).map((i) => i.ref);
  assert.deepEqual(refs, [
    'profile',
    'target_title',
    'skill:0',
    'skill:1',
    'exp:brume:title',
    'exp:brume:type',
    'exp:brume:0',
    'exp:brume:1',
    'proj:0:subtitle',
    'proj:0:0',
    'proj:1:subtitle',
    'proj:1:description',
  ]);
});

test('applyTranslationFixes: every ref round-trips back to its field', () => {
  const translated = makeTranslated();
  const fixes = new Map(translationItems(translated).map((i) => [i.ref, `FIXED ${i.ref}`]));
  const out = applyTranslationFixes(translated, fixes);

  assert.equal(out.profile, 'FIXED profile');
  assert.equal(out.target_title, 'FIXED target_title');
  assert.deepEqual(out.skills, ['FIXED skill:0', 'FIXED skill:1']);
  assert.equal(out.experiences[0].title, 'FIXED exp:brume:title');
  assert.equal(out.experiences[0].type, 'FIXED exp:brume:type');
  assert.deepEqual(out.experiences[0].bullets, ['FIXED exp:brume:0', 'FIXED exp:brume:1']);
  assert.equal(out.ai_projects[0].subtitle, 'FIXED proj:0:subtitle');
  assert.deepEqual(out.ai_projects[0].bullets, ['FIXED proj:0:0']);
  assert.equal(out.ai_projects[1].description, 'FIXED proj:1:description');
});

test('applyTranslationFixes: leaves untouched fields and the original object alone', () => {
  const translated = makeTranslated();
  const out = applyTranslationFixes(translated, new Map([['exp:brume:0', 'Repaired bullet.']]));

  assert.equal(out.experiences[0].bullets[0], 'Repaired bullet.');
  assert.equal(out.experiences[0].bullets[1], 'Reported weekly.');
  assert.equal(out.profile, translated.profile);
  assert.equal(translated.experiences[0].bullets[0], 'Ran campaigns.');
});

test('applyTranslationFixes: no fixes returns the payload untouched', () => {
  const translated = makeTranslated();
  assert.equal(applyTranslationFixes(translated, new Map()), translated);
});

/* ------------------------------------------------------------------ *
 * Permis / âge — bloc 9
 * ------------------------------------------------------------------ */

test('licenceIsRelevant: true when the offer talks travel, field work or a vehicle', () => {
  assert.equal(licenceIsRelevant('Des déplacements réguliers sont à prévoir.'), true);
  assert.equal(licenceIsRelevant('Permis B exigé.'), true);
  assert.equal(licenceIsRelevant('Vous serez souvent sur le terrain.'), true);
  assert.equal(licenceIsRelevant('Véhicule de service fourni.'), true);
  assert.equal(licenceIsRelevant('Occasional travel to client offices.'), true);
  assert.equal(licenceIsRelevant('A driving licence is required.'), true);
  assert.equal(licenceIsRelevant('Company car included.'), true);
});

test('licenceIsRelevant: false for a desk role, an empty offer, or no offer at all', () => {
  assert.equal(
    licenceIsRelevant('As an AI Solutions Engineer you build demos and prototypes, fully remote.'),
    false
  );
  assert.equal(licenceIsRelevant(''), false);
  assert.equal(licenceIsRelevant(null), false);
  assert.equal(licenceIsRelevant(undefined), false);
});

test('buildTranslationPayload: never carries the age to the translator', () => {
  const cv = {
    personal: { disponibilite: 'Disponible', age: '26 ans', permis: 'Permis B' },
    profil: 'Profil.',
    experiences: [{ id: 'x', titre: 'Titre', entreprise: 'E', realisations: ['R'] }],
    education: [],
    langues: [],
    competences: ['C'],
    outils: [],
    interets: ['Intérêt A', 'Intérêt B'],
    projets: [],
  };
  const payload = buildTranslationPayload(cv, { analysis: null, rewrite: null });
  assert.equal(payload.personal.age, undefined);
  assert.equal(payload.personal.permis, 'Permis B');
});

/* ------------------------------------------------------------------ *
 * Projets dans le rendu — bloc 8
 * ------------------------------------------------------------------ */

test('projects: the link is rendered when the master has one, in both variants', () => {
  for (const format of ['ats', 'design']) {
    const out = html(format, null);
    assert.match(out, /href="https:\/\/exemple-projet\.test"/);
    assert.match(out, />exemple-projet\.test</);
    assert.equal(out.includes('Projet Sans Lien'), true);
  }
});

test('projects: the section sits after the experience, or below education, as asked', () => {
  for (const format of ['ats', 'design']) {
    const top = html(format, { projects_rewritten: ['avec-lien'], projects_position: 'apres_experience' });
    assert.ok(top.indexOf('Projet Lié') < top.indexOf('Master'), `${format}: projets avant formation`);

    const bottom = html(format, { projects_rewritten: ['avec-lien'], projects_position: 'apres_formation' });
    assert.ok(bottom.indexOf('Projet Lié') > bottom.indexOf('Master'), `${format}: projets après formation`);
  }
});

test('projects: only the selected ones are rendered, in the rewrite order', () => {
  const out = html('ats', { projects_rewritten: ['sans-lien'], projects_position: 'apres_experience' });
  assert.equal(out.includes('Projet Sans Lien'), true);
  assert.equal(out.includes('Projet Lié'), false);
});

test('the template leaves no placeholder behind, whatever the slots hold', () => {
  for (const format of ['ats', 'design']) {
    assert.doesNotMatch(html(format, null), /\{\{[A-Z_]+\}\}/);
  }
});

test('contacts: the GitHub link sits right after LinkedIn, in both variants, and only when set', () => {
  const render = (format, github) => {
    const cv = makeCvForHtml();
    if (github !== undefined) cv.personal.github = github;
    return buildCvHtml(cv, {
      format,
      analysis: null,
      rewrite: null,
      lang: 'fr',
      translated: null,
      websiteMode: 'show',
      jobOffer: '',
      templatePath: TEMPLATE_PATH,
    });
  };
  for (const format of ['ats', 'design']) {
    const out = render(format, 'github.com/x');
    assert.match(out, /linkedin\.com\/in\/x<\/a>[\s\S]{0,1200}?<a href="https:\/\/github\.com\/x">github\.com\/x<\/a>/);
    for (const empty of [undefined, null, '']) {
      assert.doesNotMatch(render(format, empty), /github/i);
    }
  }
});

/* ------------------------------------------------------------------ *
 * Une page garantie — bloc 10
 * ------------------------------------------------------------------ */

test('the trim plan only ever tightens, never loosens', () => {
  const budget = (t, key) => t[key] || Infinity;
  for (let i = 1; i < TRIM_PLAN.length; i++) {
    for (const key of ['maxBullets', 'maxSkills', 'maxProjects']) {
      assert.ok(
        budget(TRIM_PLAN[i], key) <= budget(TRIM_PLAN[i - 1], key),
        `niveau ${i} : ${key} ne doit pas remonter`
      );
    }
    assert.ok(!TRIM_PLAN[i - 1].hideInterests || TRIM_PLAN[i].hideInterests);
  }
});

test('trimming drops interests, then shortens projects, then cuts the tail', () => {
  const full = html('design', null, TRIM_PLAN[0]);
  assert.match(full, /Intérêt A/);

  const noInterests = html('design', null, { hideInterests: true });
  assert.doesNotMatch(noInterests, /Intérêt A/);

  const short = html('design', null, { shortProjects: true });
  assert.match(short, /Version courte\./);
  assert.doesNotMatch(short, /Description du projet lié\./);

  const tight = html('ats', null, { maxBullets: 2, maxSkills: 5, maxProjects: 1 });
  assert.equal((tight.match(/<li>— R\d<\/li>/g) || []).length, 2);
  assert.doesNotMatch(tight, /C6/);
  assert.doesNotMatch(tight, /Projet Sans Lien/);
});

test('trimming never touches the identity, the profile or the education', () => {
  const tight = html('ats', null, TRIM_PLAN[TRIM_PLAN.length - 1]);
  assert.match(tight, /Prenom Nom/);
  assert.match(tight, /Profil\./);
  assert.match(tight, /Master/);
  assert.match(tight, /Consultant/);
});

test('the short description is used in English too, in its translated form', () => {
  const render = (trim) =>
    buildCvHtml(makeCvForHtml(), {
      format: 'ats',
      analysis: null,
      rewrite: null,
      lang: 'en',
      translated: {
        profile: 'Profile.',
        ai_projects: [
          { subtitle: 'Web app', description: 'Translated description.', description_short: 'Translated short.', bullets: [] },
        ],
      },
      websiteMode: 'none',
      jobOffer: '',
      trim,
      templatePath: TEMPLATE_PATH,
    });

  const short = render({ shortProjects: true });
  assert.match(short, /Translated short\./);
  assert.doesNotMatch(short, /Translated description\./);
  assert.doesNotMatch(short, /Version courte\./);

  assert.match(render({}), /Translated description\./);
});

test('a project "contexte" is an instruction for the tool, never printed', () => {
  const cv = makeCvForHtml();
  const proj = cv.projets.find((p) => p.description_courte);
  proj.contexte = 'Consigne interne à ne jamais imprimer.';
  ['design', 'ats'].forEach((format) => {
    [{}, { shortProjects: true }].forEach((trim) => {
      const out = buildCvHtml(cv, {
        format, analysis: null, rewrite: null, lang: 'fr', translated: null,
        websiteMode: 'none', jobOffer: '', trim, templatePath: TEMPLATE_PATH,
      });
      assert.doesNotMatch(out, /Consigne interne/);
    });
  });
});

test('fitToOnePage: stops at the first level that fits, and reports it', async () => {
  const heights = [A4_HEIGHT_PX + 200, A4_HEIGHT_PX + 80, A4_HEIGHT_PX - 10];
  const rendered = [];
  let call = 0;
  const page = {
    async setContent(htmlText) { rendered.push(htmlText); },
    async evaluate() { return heights[call++]; },
  };

  const out = await fitToOnePage(page, (trim) => `level:${JSON.stringify(trim)}`);
  assert.equal(out.fitted, true);
  assert.equal(out.zoom, 1);
  assert.equal(out.level, 2);
  assert.equal(rendered.length, 3);
});

test('fitToOnePage: a page barely over A4 is not called a fit', async () => {
  // Regression: a whole pixel of slack used to pass here, and Chrome
  // started a second page on it — a "one-page" CV that printed as two.
  let levels = 0;
  const page = {
    async setContent() { levels++; },
    async evaluate(fn, value) {
      if (value !== undefined) return undefined;
      return A4_HEIGHT_PX + 0.8;
    },
  };

  const out = await fitToOnePage(page, () => '<html></html>');
  assert.equal(levels, TRIM_PLAN.length, 'tous les niveaux doivent être tentés');
  assert.equal(out.fitted, false);
});

test('fitToOnePage: exhausting the plan falls through to the zoom floor', async () => {
  let zoomApplied = 1;
  const page = {
    async setContent() {},
    async evaluate(fn, value) {
      // fitOnePage applies the zoom through a second evaluate signature.
      if (value !== undefined) { zoomApplied = value; return undefined; }
      return A4_HEIGHT_PX + 400;
    },
  };

  const out = await fitToOnePage(page, () => '<html></html>', { minZoom: 0.85 });
  assert.equal(out.level, TRIM_PLAN.length - 1);
  assert.equal(out.fitted, false);
  assert.ok(out.zoom < 1 && out.zoom >= 0.85, `zoom ${out.zoom} dans les bornes`);
  assert.equal(zoomApplied, out.zoom);
});

test('pdfPageCount: counts page objects, and says null when it cannot tell', () => {
  const onePage = Buffer.from('%PDF-1.4\n<< /Type /Page /Parent 1 0 R >>\n<< /Type /Pages >>');
  assert.equal(pdfPageCount(onePage), 1);
  const twoPages = Buffer.from('<< /Type /Page\n>> << /Type /Page\n>> << /Type /Pages /Count 2 >>');
  assert.equal(pdfPageCount(twoPages), 2);
  assert.equal(pdfPageCount(Buffer.from('pas un pdf')), null);
});

/* ------------------------------------------------------------------ *
 * Bloc 12 — le projet "site personnel" ne double pas le lien de l'en-tête
 * ------------------------------------------------------------------ */

function makeCvWithSiteProject() {
  return {
    personal: {
      name: 'Prenom Nom',
      email: 'a@b.c',
      phone: '+33000000000',
      location: 'Paris',
      linkedin: 'linkedin.com/in/x',
      website: 'monsite.test',
      disponibilite: 'Disponible',
    },
    profil: 'Profil.',
    experiences: [{ id: 'e1', titre: 'Poste', entreprise: 'E', periode: '2024', realisations: ['R1'] }],
    education: [],
    competences: [],
    outils: [],
    langues: [],
    interets: [],
    projets: [
      { id: 'site-perso', type: 'build', nom: 'Site personnel', lien: 'https://monsite.test', description: 'Mon site.' },
      { id: 'autre', type: 'build', nom: 'Autre projet', lien: 'https://autre.test', description: 'Autre chose.' },
    ],
  };
}

test('resolveDisplayProjects: drops a project whose link matches the header, regardless of scheme or trailing slash', () => {
  const cv = { projets: [{ id: 'p', type: 'build', nom: 'P', lien: 'http://monsite.test/', description: '' }] };
  assert.equal(resolveDisplayProjects(cv, null, 'https://monsite.test').length, 0);
  assert.equal(resolveDisplayProjects(cv, null, 'monsite.test').length, 0);
  assert.equal(resolveDisplayProjects(cv, null, 'autre.test').length, 1);
  assert.equal(resolveDisplayProjects(cv, null, '').length, 1);
});

test('the personal-website project is hidden when the header already shows its link', () => {
  const cv = makeCvWithSiteProject();
  const shown = buildCvHtml(cv, {
    format: 'ats',
    analysis: null,
    rewrite: null,
    lang: 'fr',
    translated: null,
    websiteMode: 'show',
    jobOffer: '',
    templatePath: TEMPLATE_PATH,
  });
  assert.equal(shown.includes('Site personnel'), false);
  assert.equal(shown.includes('Autre projet'), true);
});

test('the personal-website project shows when the header carries no link (websiteMode "none")', () => {
  const cv = makeCvWithSiteProject();
  const hidden = buildCvHtml(cv, {
    format: 'ats',
    analysis: null,
    rewrite: null,
    lang: 'fr',
    translated: null,
    websiteMode: 'none',
    jobOffer: '',
    templatePath: TEMPLATE_PATH,
  });
  assert.equal(hidden.includes('Site personnel'), true);
});

test('buildTranslationPayload: the same duplicate-link filter applies to the translation payload', () => {
  const cv = makeCvWithSiteProject();
  const payload = buildTranslationPayload(cv, { analysis: null, rewrite: null, websiteMode: 'show' });
  assert.equal(payload.ai_projects.length, 1);
});

/* ------------------------------------------------------------------ *
 * Bloc 12 (suite) — un projet requis par le profil survit au rognage
 * ------------------------------------------------------------------ */

test('applyProjectBudget: keeps every required entry, filling the rest of the budget with the earliest optional ones', () => {
  const entries = [
    { proj: { id: 'a' }, i: 0 },
    { proj: { id: 'b' }, i: 1 },
    { proj: { id: 'required' }, i: 2 },
    { proj: { id: 'c' }, i: 3 },
  ];
  const requiredIds = new Set(['required']);

  const budget1 = applyProjectBudget(entries, 1, requiredIds);
  assert.deepEqual(budget1.map((e) => e.proj.id), ['required']);

  const budget2 = applyProjectBudget(entries, 2, requiredIds);
  assert.deepEqual(budget2.map((e) => e.proj.id), ['a', 'required']);

  // No budget constraint (or a budget the list already fits): untouched.
  assert.equal(applyProjectBudget(entries, 10, requiredIds).length, 4);
  assert.equal(applyProjectBudget(entries, Infinity, requiredIds).length, 4);
});

test('applyProjectBudget: more required entries than the budget still shows all of them', () => {
  const entries = [
    { proj: { id: 'a' }, i: 0 },
    { proj: { id: 'req1' }, i: 1 },
    { proj: { id: 'req2' }, i: 2 },
  ];
  const budgeted = applyProjectBudget(entries, 1, new Set(['req1', 'req2']));
  assert.deepEqual(budgeted.map((e) => e.proj.id), ['req1', 'req2']);
});

function makeCvWithRequiredProject() {
  return {
    personal: {
      name: 'Prenom Nom',
      email: 'a@b.c',
      phone: '+33000000000',
      location: 'Paris',
      linkedin: 'linkedin.com/in/x',
      website: '',
      disponibilite: 'Disponible',
    },
    profil: 'Profil.',
    experiences: [{ id: 'e1', titre: 'Poste', entreprise: 'E', periode: '2024', realisations: ['R1'] }],
    education: [],
    competences: [],
    outils: [],
    langues: [],
    interets: [],
    projets: [
      { id: 'proj-a', type: 'build', nom: 'Projet A', description: 'Description A.' },
      { id: 'proj-b', type: 'build', nom: 'Projet B', description: 'Description B.' },
      // Cited in the profile (rule 3) but scored last by normalizeSelection
      // — exactly the project a maxProjects trim would cut first.
      { id: 'proj-requis', type: 'build', nom: 'Projet Cité Dans Le Profil', description: 'Description requise.' },
    ],
  };
}

test('a project the profile cites survives the one-page trim even at the tightest project budget', () => {
  const cv = makeCvWithRequiredProject();
  const rewrite = {
    projects_rewritten: ['proj-a', 'proj-b', 'proj-requis'],
    projects_required: ['proj-requis'],
  };

  const out = buildCvHtml(cv, {
    format: 'ats',
    analysis: null,
    rewrite,
    lang: 'fr',
    translated: null,
    websiteMode: 'none',
    jobOffer: '',
    trim: { maxProjects: 1 },
    templatePath: TEMPLATE_PATH,
  });

  assert.equal(out.includes('Projet Cité Dans Le Profil'), true);
  assert.equal(out.includes('Projet A'), false);
  assert.equal(out.includes('Projet B'), false);
});

test('the required project keeps ITS OWN translated text after the trim, not a neighbour\'s (index alignment)', () => {
  const cv = makeCvWithRequiredProject();
  const rewrite = {
    projects_rewritten: ['proj-a', 'proj-b', 'proj-requis'],
    projects_required: ['proj-requis'],
  };
  // One translated entry per project, in resolveDisplayProjects' order —
  // same order as projects_rewritten here (no dedupe applies).
  const translated = {
    profile: 'Profile.',
    ai_projects: [
      { subtitle: 'EN subtitle A', description: '', bullets: [] },
      { subtitle: 'EN subtitle B', description: '', bullets: [] },
      { subtitle: 'EN subtitle REQUIRED', description: '', bullets: [] },
    ],
  };

  const out = buildCvHtml(cv, {
    format: 'ats',
    analysis: null,
    rewrite,
    lang: 'en',
    translated,
    websiteMode: 'none',
    jobOffer: '',
    trim: { maxProjects: 1 },
    templatePath: TEMPLATE_PATH,
  });

  assert.equal(out.includes('EN subtitle REQUIRED'), true);
  assert.equal(out.includes('EN subtitle A'), false);
  assert.equal(out.includes('EN subtitle B'), false);
});

/* ------------------------------------------------------------------ *
 * Titre du candidat — jamais l'intitulé de l'offre
 * ------------------------------------------------------------------ */

test('title: the master "titre" prints as-is, never the offer role title, in FR and EN', () => {
  const cv = { ...makeCvForHtml(), titre: 'AI Operator · Builder' };
  const opts = {
    format: 'ats',
    analysis: { role_title: 'AI Deployment Strategist' },
    rewrite: null,
    websiteMode: 'none',
    jobOffer: '',
    templatePath: TEMPLATE_PATH,
  };
  const fr = buildCvHtml(cv, { ...opts, lang: 'fr', translated: null });
  const en = buildCvHtml(cv, {
    ...opts,
    lang: 'en',
    translated: { profile: 'Profile.', target_title: 'Translated Title' },
  });
  for (const out of [fr, en]) {
    assert.match(out, /AI Operator · Builder/);
    assert.doesNotMatch(out, /AI Deployment Strategist/);
    assert.doesNotMatch(out, /Translated Title/);
  }
  assert.equal(buildTranslationPayload(cv, opts).target_title, undefined);
});

test('translationItems: each English line carries the French line it was translated from', () => {
  const fr = {
    profile: 'Profil.',
    skills: ['Repérage de cas d’usage IA', 'Conception de pipelines LLM'],
    experiences: [],
    ai_projects: [],
  };
  const en = {
    profile: 'Profile.',
    skills: ['Identifying AI use cases', 'Designing LLM pipelines'],
    experiences: [],
    ai_projects: [],
  };
  const items = translationItems(en, fr);
  assert.deepEqual(items.find((i) => i.ref === 'skill:0'), {
    ref: 'skill:0',
    fr: 'Repérage de cas d’usage IA',
    en: 'Identifying AI use cases',
  });
  // Without a source the shape is unchanged.
  assert.deepEqual(translationItems(en)[1], { ref: 'skill:0', en: 'Identifying AI use cases' });
});

test('rejectDuplicateFixes: a repair that copies another line of the CV is dropped (Dust: skill:1 → copy of skill:2)', () => {
  const items = [
    { ref: 'skill:0', en: 'Prototyping AI tools' },
    { ref: 'skill:1', en: 'Identifying AI use cases' },
    { ref: 'skill:2', en: 'Designing reliable LLM pipelines (structured output, fact-checking)' },
    { ref: 'exp:brume:0', en: 'Set up an executive reporting agent.' },
  ];
  const repaired = new Map([
    ['skill:1', 'Designing reliable LLM pipelines (structured output, fact-checking).'],
    ['exp:brume:0', 'Set up a reporting agent.'],
  ]);
  const { fixes, rejected } = rejectDuplicateFixes(items, repaired);
  assert.deepEqual([...fixes.keys()], ['exp:brume:0']);
  assert.deepEqual(rejected, [{ ref: 'skill:1', duplicateOf: 'skill:2' }]);
});

test('rejectDuplicateFixes: two repairs landing on the same text keep only the first', () => {
  const items = [
    { ref: 'skill:0', en: 'A' },
    { ref: 'skill:1', en: 'B' },
  ];
  const { fixes, rejected } = rejectDuplicateFixes(items, new Map([['skill:0', 'Same'], ['skill:1', 'same']]));
  assert.deepEqual([...fixes.keys()], ['skill:0']);
  assert.deepEqual(rejected, [{ ref: 'skill:1', duplicateOf: 'skill:0' }]);
});

test('rejectDuplicateFixes: a repair that rewords its own line is kept', () => {
  const items = [{ ref: 'skill:0', en: 'Client and executive stakeholders' }];
  const { fixes, rejected } = rejectDuplicateFixes(items, new Map([['skill:0', 'Client and senior stakeholders']]));
  assert.equal(fixes.get('skill:0'), 'Client and senior stakeholders');
  assert.deepEqual(rejected, []);
});
