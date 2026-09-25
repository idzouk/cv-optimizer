'use strict';

const fs = require('fs');
const { atomicWriteJson } = require('./util');

/* ------------------------------------------------------------------ *
 * [FIXE] — immutable master-CV values
 *
 * Any string in master-cv.json prefixed with "[FIXE] " is a fact the
 * model is never allowed to restate in its own words: job titles,
 * company names, dates, diplomas. The marker is stripped when the file
 * is loaded, and the clean value is re-injected into the final CV after
 * generation — so even a model that ignores the instruction cannot
 * change it. That is what stops "Media Buyer" from quietly becoming
 * "AI & Growth Consultant".
 * ------------------------------------------------------------------ */

const FIXED_MARKER = /^\s*\[FIXE\]\s*/;

/** Recursively strips [FIXE] markers, collecting the paths that carried one. */
function stripFixedMarkers(node, fixedPaths, trail = '') {
  if (typeof node === 'string') {
    if (FIXED_MARKER.test(node)) {
      fixedPaths.add(trail);
      return node.replace(FIXED_MARKER, '');
    }
    return node;
  }
  if (Array.isArray(node)) {
    return node.map((item, i) => stripFixedMarkers(item, fixedPaths, `${trail}[${i}]`));
  }
  if (node && typeof node === 'object') {
    const out = {};
    for (const [key, value] of Object.entries(node)) {
      out[key] = stripFixedMarkers(value, fixedPaths, trail ? `${trail}.${key}` : key);
    }
    return out;
  }
  return node;
}

/** True when this experience's job title is marked immutable. */
function titleIsFixed(cv, index) {
  return cv._fixedPaths && cv._fixedPaths.has(`experiences[${index}].titre`);
}

/**
 * The minimum shape every downstream function assumes exists —
 * buildMasterCvText, resolveExperiences and the fact-checkers all read
 * these fields directly, with no guard for them being missing.
 */
function validateMasterCv(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return ['Le contenu doit être un objet JSON.'];
  }

  const errors = [];

  if (!payload.personal || typeof payload.personal !== 'object') {
    errors.push('"personal" est requis et doit être un objet.');
  } else {
    ['name', 'email', 'phone', 'location'].forEach((key) => {
      if (typeof payload.personal[key] !== 'string' || !payload.personal[key]) {
        errors.push(`"personal.${key}" est requis (chaîne non vide).`);
      }
    });
  }

  if (!Array.isArray(payload.experiences) || !payload.experiences.length) {
    errors.push('"experiences" est requis et doit être un tableau non vide.');
  } else {
    const ids = [];
    payload.experiences.forEach((exp, i) => {
      if (!exp || typeof exp.id !== 'string' || !exp.id) {
        errors.push(`experiences[${i}].id est requis (chaîne non vide).`);
      } else {
        ids.push(exp.id);
      }
      if (!Array.isArray(exp && exp.realisations)) {
        errors.push(`experiences[${i}].realisations doit être un tableau.`);
      }
    });
    const dupes = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
    // Every downstream lookup keys experiences by id (resolveExperiences,
    // normalizeSelection) — a duplicate silently shadows the earlier one.
    if (dupes.length) errors.push(`ids d'expérience en double : ${dupes.join(', ')}.`);
  }

  if (payload.competences !== undefined && !Array.isArray(payload.competences)) {
    errors.push('"competences" doit être un tableau.');
  }

  if (!Array.isArray(payload.projets)) {
    errors.push('"projets" est requis et doit être un tableau.');
  } else {
    const ids = [];
    payload.projets.forEach((proj, i) => {
      if (!proj || typeof proj.id !== 'string' || !proj.id) {
        errors.push(`projets[${i}].id est requis (chaîne non vide).`);
      } else {
        ids.push(proj.id);
      }
      if (proj && proj.type !== 'conseil' && proj.type !== 'build') {
        errors.push(`projets[${i}].type doit être "conseil" ou "build".`);
      }
      if (proj && proj.type === 'conseil' && !Array.isArray(proj.realisations)) {
        errors.push(`projets[${i}].realisations doit être un tableau (type "conseil").`);
      }
    });
    const dupes = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
    if (dupes.length) errors.push(`ids de projet en double : ${dupes.join(', ')}.`);
  }

  return errors;
}

/**
 * Bound reader/writer for one master-cv.json path: raw read (markers
 * intact, for the editor), clean read (markers stripped, for everything
 * else), and a validated atomic write.
 *
 * `fallbackPath` (the fictional example CV) is read while masterCvPath
 * doesn't exist yet. Writes always go to masterCvPath, so the first save
 * from the editor creates the user's own file and leaves the example as is.
 */
function createMasterCvStore(masterCvPath, { fallbackPath } = {}) {
  /** The file reads come from: the user's own CV, else the example. */
  function activeMasterCvPath() {
    return fallbackPath && !fs.existsSync(masterCvPath) ? fallbackPath : masterCvPath;
  }

  /** Raw master CV, markers intact — used by the editor endpoints. */
  function readMasterCvRaw() {
    return JSON.parse(fs.readFileSync(activeMasterCvPath(), 'utf8'));
  }

  /**
   * Master CV with [FIXE] markers stripped, plus the set of immutable
   * paths. Everything downstream of this works with clean values.
   */
  function readMasterCv() {
    const fixedPaths = new Set();
    const cv = stripFixedMarkers(readMasterCvRaw(), fixedPaths);
    // Non-enumerable so it never leaks into a JSON.stringify of the CV.
    Object.defineProperty(cv, '_fixedPaths', { value: fixedPaths, enumerable: false });
    return cv;
  }

  /**
   * Validates, then writes via a temp file + rename in the same directory.
   * A rename on the same filesystem is atomic — a crash or a concurrent
   * read either sees the old file whole or the new one whole, never a
   * half-written one. Throws (with `.status = 400`) instead of writing on
   * a validation failure.
   */
  async function writeMasterCv(payload) {
    const errors = validateMasterCv(payload);
    if (errors.length) {
      const err = new Error(errors.join(' '));
      err.status = 400;
      throw err;
    }
    await atomicWriteJson(masterCvPath, payload);
  }

  return { activeMasterCvPath, readMasterCvRaw, readMasterCv, writeMasterCv };
}

/**
 * Flattened rendering of the master CV for the model.
 *
 * Every selectable item is numbered. Step 2 answers with those numbers
 * alongside its wording, which is what lets step 3 check each line
 * against the exact source it claims to come from.
 */
function buildMasterCvText(cv) {
  const L = [];
  const p = cv.personal;

  L.push(`NOM: ${p.name}`);
  L.push(`CONTACT: ${p.email} · ${p.phone} · ${p.location} · ${p.linkedin} · ${p.website}`);
  // Age stays out of the model's view entirely: it is never printed, and a
  // model that sees it tends to slip it into the profile ("27-year-old…").
  L.push(`DISPONIBILITÉ: ${[p.disponibilite, p.permis].filter(Boolean).join(' · ')}`);
  L.push('');
  L.push('PROFIL (version par défaut):');
  L.push(cv.profil || '');
  if ((cv.profil_variants || []).length) {
    L.push('');
    L.push('PROFIL — AUTRES ANGLES DISPONIBLES (mêmes faits, accent différent):');
    cv.profil_variants.forEach((v) => L.push(`[angle: ${v.angle}] ${v.texte}`));
  }
  L.push('');
  L.push('COMPÉTENCES — RÉSERVE (sélectionne par numéro, n’en invente aucune):');
  (cv.competences || []).forEach((s, i) => L.push(`  ${i}. ${s}`));
  L.push('');
  L.push('EXPÉRIENCES:');
  (cv.experiences || []).forEach((exp, xi) => {
    const meta = [exp.entreprise, exp.lieu, exp.type].filter(Boolean).join(' · ');
    const lock = titleIsFixed(cv, xi) ? '  [TITRE VERROUILLÉ — non modifiable]' : '';
    L.push(`[id: ${exp.id}] ${exp.titre} — ${meta} (${exp.periode || ''})${lock}`);
    if (exp.contexte) L.push(`  contexte: ${exp.contexte}`);
    L.push('  réalisations disponibles (sélectionne par numéro):');
    (exp.realisations || []).forEach((b, i) => L.push(`    ${i}. ${b}`));
  });
  L.push('');
  L.push('PROJETS:');
  (cv.projets || []).forEach((proj) => {
    if (proj.type === 'conseil') {
      L.push(`[id: ${proj.id}] [type: conseil] ${proj.nom} — ${proj.sous_titre || ''} (${proj.periode || ''})`);
      if (proj.contexte) L.push(`  contexte: ${proj.contexte}`);
      L.push('  réalisations disponibles (sélectionne par numéro):');
      (proj.realisations || []).forEach((b, i) => L.push(`    ${i}. ${b}`));
    } else {
      L.push(`- [id: ${proj.id}] [type: build] ${proj.nom} — ${proj.sous_titre || ''}`);
      if (proj.contexte) L.push(`  contexte: ${proj.contexte}`);
      L.push(`  ${proj.description || ''}`);
      if (proj.description_courte) L.push(`  (version courte: ${proj.description_courte})`);
    }
  });
  L.push('');
  L.push('FORMATION:');
  (cv.education || []).forEach((ed) => L.push(`- ${ed.diplome} — ${ed.ecole} (${ed.periode}) · ${ed.detail || ''}`));
  L.push('');
  L.push('LANGUES:');
  (cv.langues || []).forEach((lg) => L.push(`- ${lg.nom}: ${lg.niveau}`));
  L.push('');
  L.push('OUTILS — RÉSERVE (sélectionne les catégories pertinentes par numéro):');
  (cv.outils || []).forEach((t, i) => L.push(`  ${i}. ${t.label}: ${t.valeur}`));
  L.push('');
  L.push(`CENTRES D'INTÉRÊT: ${(cv.interets || []).join(' · ')}`);

  return L.join('\n');
}

/**
 * Step 2 sometimes returns a title that already carries the company and dates
 * ("Consultant Stratégie — Entreprise · Paris · Alternance (Août 2024 — Août 2026)").
 * The layout prints those on their own lines, so strip them to avoid printing
 * the same information three times.
 */
function cleanExperienceTitle(title, exp) {
  let t = String(title || '').trim();

  if (exp.entreprise) {
    const at = t.indexOf(exp.entreprise);
    // Only strip when the company appears *after* the actual job title.
    if (at > 0) t = t.slice(0, at);
  }
  // Any leftover trailing "(… 2024 …)" date parenthesis.
  t = t.replace(/\s*\([^()]*\d{4}[^()]*\)\s*$/u, '');
  // Trailing separators left behind by either cut.
  t = t.replace(/[\s—–\-·,|(]+$/u, '').trim();

  return t || String(title || '').trim();
}

/**
 * Merges the master CV's experiences with the tailored rewrite, keyed by
 * experience id. Always French — English is a translation overlay applied
 * on top in buildCvHtml.
 *
 * Two guarantees enforced here rather than asked of the model:
 *  - a [FIXE] job title always wins over anything the model proposed;
 *  - experiences the rewrite kept are returned in the rewrite's order,
 *    and each carries its own company/place/type, so callers never have
 *    to index back into cv.experiences.
 */
function resolveExperiences(cv, rewrite) {
  const byId = new Map(cv.experiences.map((exp, i) => [exp.id, { exp, i }]));
  const rewritten = (rewrite && rewrite.experiences_rewritten) || [];

  // Order: the rewrite's own order when it selected any, else master order.
  const order = rewritten.length
    ? rewritten.map((r) => r.id).filter((id) => byId.has(id))
    : cv.experiences.map((e) => e.id);

  const overrideById = new Map(rewritten.map((e) => [e.id, e]));

  return order.map((id) => {
    const { exp, i } = byId.get(id);
    const over = overrideById.get(id);
    const proposed = over && over.title;

    return {
      id: exp.id,
      // A locked title is copied through verbatim, whatever the model said.
      title: proposed && !titleIsFixed(cv, i) ? cleanExperienceTitle(proposed, exp) : exp.titre,
      entreprise: exp.entreprise || '',
      lieu: exp.lieu || '',
      type: exp.type || '',
      meta: [exp.entreprise, exp.lieu, exp.type].filter(Boolean).join(' · '),
      period: exp.periode || '',
      // The pools hold more material than a page can show, so an unselected
      // experience falls back to the top of its pool, never the whole thing.
      bullets:
        over && over.bullets && over.bullets.length
          ? over.bullets
          : (exp.realisations || []).slice(0, 3),
    };
  });
}

/**
 * Normalizes cv.projets for rendering: "conseil" projects carry bullets
 * (the realisations step 2 picked for them, else the top 3 of their pool,
 * mirroring resolveExperiences' unselected fallback); "build" projects
 * carry their fixed description as-is.
 *
 * Like resolveExperiences, the rewrite decides which projects survive and
 * in what order; without one, the master order stands.
 */
/** A "conseil" project's printed realisations: the rewrite's picks (master
 *  indices, verbatim) when it made any, else the top 3 of the pool. */
function conseilBullets(proj, rewrite) {
  const pool = proj.realisations || [];
  const picks = rewrite && rewrite.projects_realisations && rewrite.projects_realisations[proj.id];
  const chosen = Array.isArray(picks) ? picks.filter((i) => Number.isInteger(i) && pool[i] !== undefined) : [];
  return chosen.length ? chosen.map((i) => pool[i]) : pool.slice(0, 3);
}

function resolveProjects(cv, rewrite) {
  const pool = cv.projets || [];
  const byId = new Map(pool.map((p) => [p.id, p]));
  const selected = (rewrite && rewrite.projects_rewritten) || [];
  const ordered = selected.length
    ? selected.filter((id) => byId.has(id)).map((id) => byId.get(id))
    : pool;

  return ordered.map((proj) => {
    if (proj.type === 'conseil') {
      return {
        id: proj.id,
        type: proj.type,
        nom: proj.nom,
        nomEn: proj.nom_en || '',
        sousTitre: proj.sous_titre || '',
        periode: proj.periode || '',
        lien: proj.lien || null,
        bullets: conseilBullets(proj, rewrite),
      };
    }
    return {
      id: proj.id,
      type: proj.type || 'build',
      nom: proj.nom,
      nomEn: proj.nom_en || '',
      sousTitre: proj.sous_titre || '',
      lien: proj.lien || null,
      description: proj.description || '',
      descriptionCourte: proj.description_courte || '',
    };
  });
}

/**
 * Resolves a keyword's claimed proof ("<id>/<n>" for a realisation of an
 * experience or "conseil" project, "<id>" for a "build" project) to the
 * master text behind it, or null when the reference points at nothing.
 */
function keywordProof(cv, ref) {
  const m = String(ref || '').trim().match(/^([^/\s]+)(?:\/(\d+))?$/);
  if (!m) return null;
  const [, id, n] = m;
  const exp = (cv.experiences || []).find((e) => e.id === id);
  const proj = (cv.projets || []).find((p) => p.id === id);
  if (n !== undefined) {
    const pool = (exp && exp.realisations) || (proj && proj.type === 'conseil' && proj.realisations) || [];
    return pool[Number(n)] || null;
  }
  return proj && proj.type === 'build' ? proj.description || null : null;
}

/**
 * Step 1 may only recommend adding an offer keyword that a master
 * realisation actually backs. The model answers each one with the
 * reference of its proof; anything without a resolvable proof is moved to
 * "keyword_gaps" — shown as a real gap, never passed on to step 2 as
 * something to add. Keeps the flat string list the rest of the app reads.
 */
function groundMissingKeywords(cv, analysis) {
  const backed = [];
  const gaps = (analysis.keyword_gaps || []).map(String).filter(Boolean);
  (analysis.missing_keywords || []).forEach((k) => {
    const keyword = typeof k === 'string' ? k : k && k.mot_cle;
    if (!keyword) return;
    const proof = typeof k === 'object' ? keywordProof(cv, k.source) : null;
    if (proof) backed.push({ mot_cle: keyword, source: k.source, preuve: proof });
    else if (!gaps.includes(keyword)) gaps.push(keyword);
  });
  return {
    ...analysis,
    missing_keywords: backed.map((b) => b.mot_cle),
    missing_keywords_proof: backed,
    keyword_gaps: gaps,
  };
}

module.exports = {
  FIXED_MARKER,
  stripFixedMarkers,
  titleIsFixed,
  validateMasterCv,
  createMasterCvStore,
  buildMasterCvText,
  cleanExperienceTitle,
  resolveExperiences,
  resolveProjects,
  keywordProof,
  groundMissingKeywords,
};
