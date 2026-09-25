'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeSelection } = require('../lib/rewrite');

/**
 * This is step 2's grounding contract: the model picks by index into these
 * pools, and normalizeSelection re-resolves every pick against them rather
 * than trusting the model's text. These tests exist to catch a regression
 * in that re-resolution — the exact thing step 3 (fact-checking) depends on.
 */
function makeCv() {
  return {
    profil: 'Profil par défaut.',
    competences: ['Compétence A', 'Compétence B', 'Compétence C'],
    experiences: [
      {
        id: 'exp1',
        titre: 'Consultant',
        realisations: ['Réalisation 1', 'Réalisation 2', 'Réalisation 3', 'Réalisation 4', 'Réalisation 5'],
      },
      {
        id: 'exp2',
        titre: 'Stagiaire',
        realisations: ['Autre réalisation A', 'Autre réalisation B'],
      },
    ],
    outils: [
      { label: 'LLMs & GenAI', valeur: 'Claude · ChatGPT' },
      { label: 'Ads', valeur: 'Meta Ads · TikTok Ads' },
      { label: 'Bureautique', valeur: 'Microsoft 365 · Google Workspace' },
    ],
    projets: [
      { id: 'conseil1', type: 'conseil', nom: 'Mission conseil', realisations: ['R1', 'R2'] },
      { id: 'build1', type: 'build', nom: 'Outil A', description: 'Description A' },
      { id: 'build2', type: 'build', nom: 'Outil B', description: 'Description B' },
    ],
  };
}

test('picks by source index and flags reformulated lines as changed', () => {
  const cv = makeCv();
  const selection = {
    // The model's profile paraphrase is ignored: the master text prints as-is.
    profils: [{ angle: 'defaut', texte: 'Profil adapté à l’offre.', scores_dimensions: [80] }],
    experiences: [
      {
        id: 'exp1',
        bullets: [
          { source: 0, texte: 'Réalisation 1 reformulée' },
          { source: 2, texte: 'Réalisation 3' }, // identical to source → not "changed"
        ],
      },
    ],
    competences: [{ source: 1, texte: 'Compétence B' }],
    changes_summary: ['mis en avant X'],
  };

  const result = normalizeSelection(cv, selection);

  assert.equal(result.summary_rewritten, cv.profil);
  assert.deepEqual(result.experiences_rewritten[0].bullets, [
    'Réalisation 1 reformulée',
    'Réalisation 3',
  ]);
  assert.deepEqual(result.skills_rewritten, ['Compétence B']);

  const g = result._grounded;
  assert.equal(g.experiences[0].picked[0].changed, true);
  assert.equal(g.experiences[0].picked[1].changed, false);
  assert.equal(g.skills[0].changed, false);
});

test('falls back to verbatim top-of-pool when the selection is empty', () => {
  const cv = makeCv();
  const result = normalizeSelection(cv, null);

  assert.equal(result.summary_rewritten, cv.profil);
  assert.equal(result.experiences_rewritten.length, 2);
  assert.deepEqual(result.experiences_rewritten[0].bullets, cv.experiences[0].realisations.slice(0, 3));
  assert.deepEqual(result.experiences_rewritten[1].bullets, cv.experiences[1].realisations.slice(0, 3));
  assert.deepEqual(result.skills_rewritten, cv.competences);
  result._grounded.experiences.forEach((exp) =>
    exp.picked.forEach((p) => assert.equal(p.changed, false))
  );
});

test('drops duplicate experience ids and selections for unknown ids', () => {
  const cv = makeCv();
  const selection = {
    experiences: [
      { id: 'exp1', bullets: [{ source: 0, texte: '' }] },
      { id: 'exp1', bullets: [{ source: 1, texte: 'devrait être ignoré (doublon)' }] },
      { id: 'inconnu', bullets: [{ source: 0, texte: 'devrait être ignoré (id inexistant)' }] },
    ],
  };

  const result = normalizeSelection(cv, selection);

  assert.equal(result.experiences_rewritten.length, 1);
  assert.equal(result.experiences_rewritten[0].id, 'exp1');
  // Empty "texte" falls back to the source line verbatim, and the density
  // floor (rule 6b) tops a single bullet back up to 2 from the same pool.
  assert.deepEqual(result.experiences_rewritten[0].bullets, ['Réalisation 1', 'Réalisation 2']);
});

test('an invalid bullet source index falls back to the top of that pool', () => {
  const cv = makeCv();
  const selection = {
    experiences: [{ id: 'exp1', bullets: [{ source: 99, texte: 'ghost' }] }],
  };

  const result = normalizeSelection(cv, selection);

  assert.deepEqual(result.experiences_rewritten[0].bullets, cv.experiences[0].realisations.slice(0, 3));
});

test('sorts bullets by score before capping, keeping the highest-scored 4', () => {
  const cv = makeCv();
  cv.experiences[0].realisations = ['R0', 'R1', 'R2', 'R3', 'R4', 'R5'];

  // Listed in the model's arbitrary order, with the two most relevant ones
  // (R4, R1) placed last — a raw slice(0, 4) would drop them.
  const selection = {
    experiences: [
      {
        id: 'exp1',
        bullets: [
          { source: 0, texte: 'R0', score: 40 },
          { source: 2, texte: 'R2', score: 30 },
          { source: 3, texte: 'R3', score: 20 },
          { source: 5, texte: 'R5', score: 10 },
          { source: 4, texte: 'R4', score: 90 },
          { source: 1, texte: 'R1', score: 80 },
        ],
      },
    ],
  };

  const result = normalizeSelection(cv, selection);
  assert.deepEqual(result.experiences_rewritten[0].bullets, ['R4', 'R1', 'R0', 'R2']);
});

test('sorts skills by score before capping to 8, and an unscored item sorts last', () => {
  const cv = makeCv();
  cv.competences = Array.from({ length: 9 }, (_, i) => `Comp ${i}`);

  const selection = {
    competences: cv.competences.map((c, i) => ({
      source: i,
      texte: c,
      // Comp 0 carries no score at all; every other item outranks it.
      score: i === 0 ? undefined : 100 - i,
    })),
  };

  const result = normalizeSelection(cv, selection);
  assert.equal(result.skills_rewritten.length, 8);
  assert.ok(!result.skills_rewritten.includes('Comp 0'));
  assert.deepEqual(result.skills_rewritten, ['Comp 1', 'Comp 2', 'Comp 3', 'Comp 4', 'Comp 5', 'Comp 6', 'Comp 7', 'Comp 8']);
});

test('tools: an explicit selection is honoured, Bureautique included', () => {
  const cv = makeCv();
  const result = normalizeSelection(cv, { outils: [1, 2] });
  assert.deepEqual(result.tools_rewritten.map((t) => t.label), ['Ads', 'Bureautique']);
});

test('tools: no selection falls back to every category except Bureautique', () => {
  const cv = makeCv();
  assert.deepEqual(
    normalizeSelection(cv, null).tools_rewritten.map((t) => t.label),
    ['LLMs & GenAI', 'Ads']
  );
  assert.deepEqual(
    normalizeSelection(cv, { outils: [] }).tools_rewritten.map((t) => t.label),
    ['LLMs & GenAI', 'Ads']
  );
});

test('tools: an invalid or duplicate index is ignored, not crashed on', () => {
  const cv = makeCv();
  const result = normalizeSelection(cv, { outils: [0, 0, 99, -1] });
  assert.deepEqual(result.tools_rewritten.map((t) => t.label), ['LLMs & GenAI']);
});

test('caps bullets at 4 per experience and skills at 8 total', () => {
  const cv = makeCv();
  cv.experiences[0].realisations = ['R0', 'R1', 'R2', 'R3', 'R4', 'R5'];
  cv.competences = Array.from({ length: 12 }, (_, i) => `Comp ${i}`);

  const selection = {
    experiences: [
      {
        id: 'exp1',
        bullets: cv.experiences[0].realisations.map((r, i) => ({ source: i, texte: r })),
      },
    ],
    competences: cv.competences.map((c, i) => ({ source: i, texte: c })),
  };

  const result = normalizeSelection(cv, selection);

  assert.equal(result.experiences_rewritten[0].bullets.length, 4);
  assert.equal(result.skills_rewritten.length, 8);
});

/* ------------------------------------------------------------------ *
 * Projets — bloc 8
 * ------------------------------------------------------------------ */

test('projects: kept by id, ordered by score, unselected ones dropped', () => {
  const cv = makeCv();
  const out = normalizeSelection(cv, {
    projets: [
      { id: 'build2', score: 40 },
      { id: 'build1', score: 90 },
    ],
  });
  assert.deepEqual(out.projects_rewritten, ['build1', 'build2']);
});

test('projects: unknown and duplicate ids are ignored, not crashed on', () => {
  const cv = makeCv();
  const out = normalizeSelection(cv, {
    projets: [
      { id: 'build1', score: 80 },
      { id: 'build1', score: 99 },
      { id: 'inexistant', score: 100 },
      { id: 'conseil1', score: 70 },
    ],
  });
  assert.deepEqual(out.projects_rewritten, ['build1', 'conseil1']);
});

test('projects: no selection keeps the master order, never an empty section', () => {
  const cv = makeCv();
  assert.deepEqual(normalizeSelection(cv, {}).projects_rewritten, ['conseil1', 'build1', 'build2']);
  assert.deepEqual(normalizeSelection(cv, { projets: [] }).projects_rewritten, [
    'conseil1',
    'build1',
    'build2',
  ]);
});

test('projects: position follows the model, and defaults to after the experience', () => {
  const cv = makeCv();
  assert.equal(
    normalizeSelection(cv, { projets_position: 'apres_formation' }).projects_position,
    'apres_formation'
  );
  assert.equal(
    normalizeSelection(cv, { projets_position: 'apres_experience' }).projects_position,
    'apres_experience'
  );
  assert.equal(normalizeSelection(cv, {}).projects_position, 'apres_experience');
  assert.equal(normalizeSelection(cv, { projets_position: 'nimporte' }).projects_position, 'apres_experience');
});

/* ------------------------------------------------------------------ *
 * Bloc 12 — corrections issues du test réel
 * ------------------------------------------------------------------ */

test('bullets: a real score gap always wins, evidence never overrides it', () => {
  const cv = makeCv();
  cv.experiences[0].realisations = [
    'Piloté un chantier stratégique majeur pour le comité de direction',
    'Automatisé mon propre workflow en interne pour gagner du temps',
  ];
  const selection = {
    experiences: [
      {
        id: 'exp1',
        bullets: [
          { source: 0, texte: 'Piloté un chantier stratégique majeur pour le comité de direction', score: 90 },
          { source: 1, texte: 'Automatisé mon propre workflow en interne pour gagner du temps', score: 40 },
        ],
      },
    ],
  };
  const result = normalizeSelection(cv, selection);
  // 90 vs 40 is far past the tie window: the score order stands even though
  // the lower-scored bullet has no number and the higher-scored one does.
  assert.deepEqual(result.experiences_rewritten[0].bullets, [
    'Piloté un chantier stratégique majeur pour le comité de direction',
    'Automatisé mon propre workflow en interne pour gagner du temps',
  ]);
});

test('bullets: real agency-style regression — a named-brand ROAS bullet outranks a self-automation bullet despite a 10-point score deficit', () => {
  const cv = makeCv();
  const roas =
    'Campagnes de conversion e-commerce et reporting de performance pour de nombreuses marques mode, ' +
    'luxe et retail (Maison Orée, Lune & Sel, Vélo Rivière, Atelier Nacre…), avec des ROAS régulièrement ' +
    'supérieurs à 7 sur les lancements.';
  const zapier =
    "Automatisation de mon propre workflow : brouillons d'emails clients via Zapier, agent d'analyse " +
    'de données de campagne sous Claude.';
  cv.experiences[0].realisations = [zapier, roas];

  const result = normalizeSelection(cv, {
    experiences: [
      {
        id: 'exp1',
        // The model over-indexed the automation bullet on an AI-flavoured
        // offer — this is the exact reported bug: raw score alone would
        // have kept it first.
        bullets: [
          { source: 0, texte: zapier, score: 75 },
          { source: 1, texte: roas, score: 65 },
        ],
      },
    ],
  });

  assert.deepEqual(result.experiences_rewritten[0].bullets, [roas, zapier]);
  const picked = result._grounded.experiences[0].picked;
  assert.equal(picked[0].effectiveScore > picked[1].effectiveScore, true);
});

test('bullets: a close score is broken by evidence — a figure or a named client beats a plain or internal task', () => {
  const cv = makeCv();
  cv.experiences[0].realisations = [
    'Automatisé la préparation de mes propres reportings en interne',
    'Piloté une campagne pour Client Corp avec un budget de 40k€',
  ];
  const selection = {
    experiences: [
      {
        id: 'exp1',
        bullets: [
          // Listed weaker-evidence bullet first, with a slightly higher
          // score — still within the tie window (diff 3).
          { source: 0, texte: 'Automatisé la préparation de mes propres reportings en interne', score: 60 },
          { source: 1, texte: 'Piloté une campagne pour Client Corp avec un budget de 40k€', score: 57 },
        ],
      },
    ],
  };
  const result = normalizeSelection(cv, selection);
  assert.deepEqual(result.experiences_rewritten[0].bullets, [
    'Piloté une campagne pour Client Corp avec un budget de 40k€',
    'Automatisé la préparation de mes propres reportings en interne',
  ]);
});

test('density floor: an experience keeps at least 2 bullets when its pool allows it, even if only 1 was scored', () => {
  const cv = makeCv();
  const result = normalizeSelection(cv, {
    experiences: [{ id: 'exp1', bullets: [{ source: 0, texte: 'Seule bullet retenue', score: 80 }] }],
  });
  assert.equal(result.experiences_rewritten[0].bullets.length, 2);
  assert.equal(result.experiences_rewritten[0].bullets[0], 'Seule bullet retenue');
});

test('density floor: never crashes or duplicates when the pool itself has fewer than 2 entries', () => {
  const cv = makeCv();
  const result = normalizeSelection(cv, {
    experiences: [{ id: 'exp2', bullets: [{ source: 0, texte: 'Une seule dispo', score: 80 }] }],
  });
  // exp2's pool only has 2 realisations total; asking for a 2nd still works.
  assert.deepEqual(result.experiences_rewritten[0].bullets.sort(), ['Autre réalisation B', 'Une seule dispo']);
});

test('profile/body consistency: a company or project named in the profile is added back to the body', () => {
  const cv = makeCv();
  cv.experiences.push({
    id: 'exp3',
    titre: 'Chargé de projet',
    entreprise: 'Entreprise Distinctive',
    realisations: ['Une réalisation chez Entreprise Distinctive'],
  });
  cv.profil = 'Profil qui mentionne Entreprise Distinctive et le projet Outil A.';

  const result = normalizeSelection(cv, {
    profils: [{ angle: 'defaut', scores_dimensions: [80] }],
    experiences: [{ id: 'exp1', bullets: [{ source: 0, texte: 'Réalisation 1', score: 50 }] }],
    projets: [{ id: 'build2', score: 50 }],
  });

  assert.ok(result.experiences_rewritten.some((e) => e.id === 'exp3'));
  assert.ok(result.projects_rewritten.includes('build1'));
  // Flagged so the one-page trim knows not to cut it (see render.test.js).
  assert.deepEqual(result.projects_required, ['build1']);
});

test('profile/body consistency: a name absent from the profile is not force-added', () => {
  const cv = makeCv();
  const result = normalizeSelection(cv, {
    profils: [{ angle: 'defaut', texte: 'Profil générique, sans nom propre.', scores_dimensions: [80] }],
    experiences: [{ id: 'exp1', bullets: [{ source: 0, texte: 'Réalisation 1', score: 50 }] }],
    projets: [{ id: 'build2', score: 50 }],
  });
  assert.deepEqual(
    result.experiences_rewritten.map((e) => e.id),
    ['exp1']
  );
  assert.deepEqual(result.projects_rewritten, ['build2']);
  assert.deepEqual(result.projects_required, []);
});

test('profile/body consistency: catches a short-form company mention ("Hestia") even when the master name has a suffix ("Hestia Groupe")', () => {
  const cv = makeCv();
  cv.projets.push({
    id: 'hestia',
    type: 'conseil',
    nom: 'Hestia Groupe',
    realisations: ['Conçu un cadre de pilotage pour Hestia Groupe'],
  });
  cv.profil = 'Pour Hestia, j’ai conçu un cadre de pilotage.';

  const result = normalizeSelection(cv, {
    profils: [{ angle: 'defaut', scores_dimensions: [80] }],
    experiences: [{ id: 'exp1', bullets: [{ source: 0, texte: 'Réalisation 1', score: 50 }] }],
    projets: [{ id: 'build2', score: 50 }],
  });

  assert.ok(result.projects_rewritten.includes('hestia'));
  assert.ok(result.projects_required.includes('hestia'));
});

test('profile/body consistency: checked against the chosen angle\'s own master text, whatever the model paraphrased', () => {
  const cv = makeCv();
  cv.profil_variants = [{ angle: 'conseil', texte: 'Pour Hestia Groupe, un cadre de pilotage.' }];
  cv.projets.push({
    id: 'hestia',
    type: 'conseil',
    nom: 'Hestia Groupe',
    realisations: ['Conçu un cadre de pilotage pour Hestia Groupe'],
  });

  // The model's own paraphrase drifted and dropped the company name — the
  // angle's master source text still names it, and that alone is enough.
  const result = normalizeSelection(cv, {
    profils: [{ angle: 'conseil', texte: 'Pour un grand groupe, un cadre de pilotage.', scores_dimensions: [80] }],
    experiences: [{ id: 'exp1', bullets: [{ source: 0, texte: 'Réalisation 1', score: 50 }] }],
  });

  assert.ok(result.projects_rewritten.includes('hestia'));
});

/* ------------------------------------------------------------------ *
 * Angle de profil choisi par code (maximin sur les dimensions notées)
 * ------------------------------------------------------------------ */

test('profile angle: code picks the best WORST-of-its-dimensions score, not the best single-axis score', () => {
  const cv = makeCv();
  cv.profil_variants = [
    { angle: 'implementation_ia', texte: 'Angle IA pur.' },
    { angle: 'builder_growth', texte: 'Angle growth + IA.' },
  ];

  const result = normalizeSelection(cv, {
    profils: [
      { angle: 'defaut', texte: 'Angle par défaut.', scores_dimensions: [50, 50] },
      // Peaks on dimension 1 (growth) but craters on dimension 2 (AI/tech).
      { angle: 'implementation_ia', texte: 'Angle IA pur.', scores_dimensions: [95, 20] },
      // Balanced across both — lower max, but a much better worst case.
      { angle: 'builder_growth', texte: 'Angle growth + IA.', scores_dimensions: [70, 68] },
    ],
  });

  assert.equal(result._grounded.profil_angle, 'builder_growth');
  assert.equal(result.summary_rewritten, 'Angle growth + IA.');
});

test('profile angle: a single-dimension offer reduces to plain highest score', () => {
  const cv = makeCv();
  cv.profil_variants = [{ angle: 'paid_social', texte: 'Angle social.' }];
  const result = normalizeSelection(cv, {
    profils: [
      { angle: 'defaut', texte: 'Angle par défaut.', scores_dimensions: [60] },
      { angle: 'paid_social', texte: 'Angle social.', scores_dimensions: [85] },
    ],
  });
  assert.equal(result._grounded.profil_angle, 'paid_social');
});

test('profile angle: falls back to "defaut" when profils is missing, empty, or every candidate is malformed', () => {
  const cv = makeCv();
  const noProfils = normalizeSelection(cv, {});
  assert.equal(noProfils.summary_rewritten, cv.profil);
  assert.equal(noProfils._grounded.profil_angle, 'defaut');

  assert.equal(normalizeSelection(cv, { profils: [] }).summary_rewritten, cv.profil);
  assert.equal(
    normalizeSelection(cv, { profils: [{ angle: 'defaut', texte: '' }] }).summary_rewritten,
    cv.profil
  );
});

test('profile angle: an angle name the model invents is ignored, not trusted', () => {
  const cv = makeCv();
  const result = normalizeSelection(cv, {
    profils: [{ angle: 'invente_de_toutes_pieces', texte: 'Texte fantôme.', scores_dimensions: [100, 100] }],
  });
  assert.equal(result._grounded.profil_angle, 'defaut');
  assert.equal(result.summary_rewritten, cv.profil);
});

test('duplicates: a bullet that only names an already-shown project is dropped and backfilled', () => {
  const cv = makeCv();
  cv.experiences[0].realisations = [
    'A prototypé et présenté en interne un premier Outil A',
    'Géré la relation client au quotidien',
    'Rédigé un mémoire sur la conduite du changement',
  ];
  const result = normalizeSelection(cv, {
    experiences: [
      {
        id: 'exp1',
        bullets: [
          { source: 0, texte: 'A prototypé et présenté en interne un premier Outil A', score: 90 },
          { source: 1, texte: 'Géré la relation client au quotidien', score: 60 },
        ],
      },
    ],
    projets: [{ id: 'build1', score: 95 }],
  });

  const bullets = result.experiences_rewritten[0].bullets;
  assert.ok(!bullets.some((b) => b.includes('Outil A')));
  // Backfilled from the rest of the pool to hold the previous count (2).
  assert.equal(bullets.length, 2);
});

test('duplicates: nothing is removed when the shown projects are never mentioned in a bullet', () => {
  const cv = makeCv();
  const result = normalizeSelection(cv, {
    experiences: [
      {
        id: 'exp1',
        bullets: [
          { source: 0, texte: 'Réalisation 1', score: 90 },
          { source: 1, texte: 'Réalisation 2', score: 80 },
        ],
      },
    ],
    projets: [{ id: 'build1', score: 95 }],
  });
  assert.deepEqual(result.experiences_rewritten[0].bullets, ['Réalisation 1', 'Réalisation 2']);
});

/* ------------------------------------------------------------------ *
 * Angle : texte du master tel quel, choix manuel
 * ------------------------------------------------------------------ */

test('profile angle: the chosen angle prints its master text verbatim, never the model paraphrase', () => {
  const cv = makeCv();
  cv.profil_variants = [{ angle: 'ai_deployment', texte: 'Texte master de l’angle déploiement.' }];
  const result = normalizeSelection(cv, {
    profils: [
      { angle: 'defaut', texte: 'Paraphrase du défaut.', scores_dimensions: [50] },
      { angle: 'ai_deployment', texte: 'Paraphrase qui accompagne l’adoption.', scores_dimensions: [90] },
    ],
  });
  assert.equal(result._grounded.profil_angle, 'ai_deployment');
  assert.equal(result.summary_rewritten, 'Texte master de l’angle déploiement.');
});

test('profile angle: a manual choice overrides the scores; an unknown manual angle is ignored', () => {
  const cv = makeCv();
  cv.profil_variants = [
    { angle: 'paid_social', texte: 'Angle social.' },
    { angle: 'conseil_ia', texte: 'Angle conseil.' },
  ];
  const selection = {
    profils: [
      { angle: 'paid_social', scores_dimensions: [90] },
      { angle: 'conseil_ia', scores_dimensions: [40] },
    ],
  };
  const manual = normalizeSelection(cv, selection, { angle: 'conseil_ia' });
  assert.equal(manual._grounded.profil_angle, 'conseil_ia');
  assert.equal(manual._grounded.profil_angle_source, 'manuel');
  assert.equal(manual.summary_rewritten, 'Angle conseil.');

  const unknown = normalizeSelection(cv, selection, { angle: 'inexistant' });
  assert.equal(unknown._grounded.profil_angle, 'paid_social');
  assert.equal(unknown._grounded.profil_angle_source, 'auto');
});

test('projects: one marked "retenu": false is never printed, whatever its score', () => {
  const cv = makeCv();
  const result = normalizeSelection(cv, {
    projets: [
      { id: 'build1', retenu: true, score: 80 },
      { id: 'build2', retenu: false, score: 95 },
    ],
  });
  assert.deepEqual(result.projects_rewritten, ['build1']);

  // Everything excluded: the master-order fallback still leaves them out.
  const none = normalizeSelection(cv, { projets: [{ id: 'build2', retenu: false, score: 50 }] });
  assert.ok(!none.projects_rewritten.includes('build2'));
});

test('projects: a "conseil" project filed under experiences is recovered as a project, not lost', () => {
  const cv = makeCv();
  cv.projets.push({ id: 'hestia', type: 'conseil', nom: 'Hestia Groupe', realisations: ['Cadre de pilotage.'] });
  const result = normalizeSelection(cv, {
    experiences: [
      { id: 'exp1', bullets: [{ source: 0, texte: 'Réalisation 1', score: 50 }] },
      { id: 'hestia', bullets: [{ source: 0, texte: 'Cadre de pilotage.', score: 88 }] },
    ],
    projets: [{ id: 'build1', retenu: true, score: 80 }],
  });
  assert.deepEqual(result.experiences_rewritten.map((e) => e.id), ['exp1']);
  assert.deepEqual(result.projects_rewritten, ['hestia', 'build1']);
});

test('projects: a "conseil" project prints the realisations step 2 picked, in its order', () => {
  const cv = makeCv();
  cv.projets.push({ id: 'hestia', type: 'conseil', nom: 'Hestia Groupe', realisations: ['R0', 'R1', 'R2 conformité', 'R3'] });
  const result = normalizeSelection(cv, {
    projets: [{ id: 'hestia', retenu: true, score: 90, realisations: [1, 0, 99, 1, 'x'] }],
  });
  assert.deepEqual(result.projects_realisations, { hestia: [1, 0] });

  const { resolveProjects } = require('../lib/masterCv');
  const hestia = resolveProjects(cv, result).find((p) => p.id === 'hestia');
  assert.deepEqual(hestia.bullets, ['R1', 'R0']);
});

test('projects: no usable pick for a "conseil" project falls back to the top 3 of its pool', () => {
  const cv = makeCv();
  cv.projets.push({ id: 'hestia', type: 'conseil', nom: 'Hestia Groupe', realisations: ['R0', 'R1', 'R2', 'R3'] });
  const result = normalizeSelection(cv, { projets: [{ id: 'hestia', retenu: true, score: 90 }] });
  assert.deepEqual(result.projects_realisations, {});
  const { resolveProjects } = require('../lib/masterCv');
  assert.deepEqual(resolveProjects(cv, result).find((p) => p.id === 'hestia').bullets, ['R0', 'R1', 'R2']);
});

test('projects: a misfiled "conseil" project keeps the realisations it was given under experiences', () => {
  const cv = makeCv();
  cv.projets.push({ id: 'hestia', type: 'conseil', nom: 'Hestia Groupe', realisations: ['R0', 'R1', 'R2', 'R3'] });
  const result = normalizeSelection(cv, {
    experiences: [{ id: 'hestia', bullets: [{ source: 3, texte: 'R3', score: 70 }, { source: 0, texte: 'R0', score: 60 }] }],
  });
  assert.deepEqual(result.projects_realisations, { hestia: [3, 0] });
});

/* ------------------------------------------------------------------ *
 * Ordre d'impression : expériences chronologiques, build avant conseil
 * ------------------------------------------------------------------ */

test('periodStart: reads the start of FR/EN master periods, markers and accents included', () => {
  const { periodStart } = require('../lib/rewrite');
  assert.equal(periodStart('[FIXE] Août 2024 — Juin 2026'), 202408);
  assert.equal(periodStart('Mars 2021 — Février 2022'), 202103);
  assert.equal(periodStart('January 2023 - June 2023'), 202301);
  assert.equal(periodStart('2021 — 2022'), 202100);
  assert.equal(periodStart(''), null);
});

test('experiences: always printed latest start first, whatever the model order or scores', () => {
  const cv = makeCv();
  cv.experiences = [
    { id: 'parallele', titre: 'Stage', periode: 'Janvier 2022 — Juin 2022', realisations: ['S1', 'S2'] },
    { id: 'brume', titre: 'Media Buyer', periode: '[FIXE] Septembre 2024 — Août 2026', realisations: ['T1', 'T2'] },
    { id: 'veloce', titre: 'Co-fondatrice', periode: 'Septembre 2022 — Juin 2023', realisations: ['L1', 'L2'] },
  ];
  const result = normalizeSelection(cv, {
    experiences: [
      { id: 'parallele', bullets: [{ source: 0, texte: 'S1', score: 99 }] },
      { id: 'veloce', bullets: [{ source: 0, texte: 'L1', score: 95 }] },
      { id: 'brume', bullets: [{ source: 0, texte: 'T1', score: 10 }] },
    ],
  });
  assert.deepEqual(result.experiences_rewritten.map((e) => e.id), ['brume', 'veloce', 'parallele']);
});

test('experiences: an unreadable period sorts last, ties keep the master order', () => {
  const cv = makeCv();
  cv.experiences = [
    { id: 'a', titre: 'A', periode: '2022 — 2023', realisations: ['A1', 'A2'] },
    { id: 'nodate', titre: 'N', periode: '', realisations: ['N1', 'N2'] },
    { id: 'b', titre: 'B', periode: '2022 — 2024', realisations: ['B1', 'B2'] },
  ];
  const result = normalizeSelection(cv, {
    experiences: ['nodate', 'b', 'a'].map((id) => ({ id, bullets: [{ source: 0, score: 50 }] })),
  });
  assert.deepEqual(result.experiences_rewritten.map((e) => e.id), ['a', 'b', 'nodate']);
});

test('projects: builder angles print "build" projects before "conseil" ones, each group by score', () => {
  const cv = makeCv();
  cv.profil_variants = [
    { angle: 'ai_deployment', texte: 'Angle déploiement.' },
    { angle: 'conseil_ia', texte: 'Angle conseil.' },
  ];
  const projets = [
    { id: 'conseil1', retenu: true, score: 95 },
    { id: 'build1', retenu: true, score: 60 },
    { id: 'build2', retenu: true, score: 80 },
  ];
  ['ai_deployment', 'implementation_ia', 'builder_growth'].forEach((angle) => {
    if (!cv.profil_variants.some((v) => v.angle === angle)) cv.profil_variants.push({ angle, texte: `Angle ${angle}.` });
    const result = normalizeSelection(cv, { projets }, { angle });
    assert.deepEqual(result.projects_rewritten, ['build2', 'build1', 'conseil1'], angle);
  });

  // Any other angle keeps the plain score order.
  const other = normalizeSelection(cv, { projets }, { angle: 'conseil_ia' });
  assert.deepEqual(other.projects_rewritten, ['conseil1', 'build2', 'build1']);
});
