'use strict';

const MONTHS = {
  janvier: 1, fevrier: 2, mars: 3, avril: 4, mai: 5, juin: 6, juillet: 7, aout: 8,
  septembre: 9, octobre: 10, novembre: 11, decembre: 12,
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8,
  september: 9, october: 10, november: 11, december: 12,
};

/** Start of a master period ("[FIXE] Août 2024 — Août 2026") as a sortable
 *  number (year * 100 + month), or null when no year can be read. */
function periodStart(periode) {
  const start = String(periode || '')
    .replace(/\[FIXE\]/g, '')
    .split(/[—–-]/)[0]
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  const year = start.match(/\b(19|20)\d{2}\b/);
  if (!year) return null;
  const month = (start.match(/[a-z]+/g) || []).map((w) => MONTHS[w]).find(Boolean) || 0;
  return Number(year[0]) * 100 + month;
}

/** Angles whose profile leads with building things: their "build" projects
 *  print before the "conseil" ones, whatever the scores. */
const BUILD_FIRST_ANGLES = new Set(['ai_deployment', 'implementation_ia', 'builder_growth']);

/**
 * Turns the grounded selection into the flat shape the renderer expects.
 *
 * `options.angle` forces a profile angle (manual choice from the UI).
 */
function normalizeSelection(cv, selection, options = {}) {
  // Coerces whatever the model sent for "score" into a comparable number;
  // an untrustworthy or missing score sorts last rather than crashing the
  // sort or silently winning a tie against a real score of 0.
  const toScore = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : -1;
  };

  const pick = (item, pool) => {
    if (!item) return null;
    const src = pool[item.source];
    if (src === undefined) return null;
    const text = String(item.texte || '').trim();
    return {
      text: text || src,
      source: item.source,
      sourceText: src,
      changed: text !== src,
      score: toScore(item.score),
    };
  };

  /** A pool entry taken as-is — the safe fallback when a pick is unusable. */
  const verbatim = (pool, i) => ({
    text: pool[i],
    source: i,
    sourceText: pool[i],
    changed: false,
    // Fallback entries have no model score; rank them by their original
    // pool order (earlier = presumed more relevant) rather than all tying.
    score: pool.length - i,
  });

  /**
   * How well a bullet PROVES itself, not just how it scored on offer
   * keywords: a figure, a named client or a concrete scope outweighs a
   * generic task, and something self-directed or purely internal
   * ("automated my own workflow", "presented internally") is weaker
   * evidence than work delivered to an actual client. Returned as a small
   * signed integer, never the whole story — see EVIDENCE_WEIGHT below for
   * how much it actually moves the ranking.
   */
  const evidenceStrength = (text) => {
    const t = String(text || '');
    let strength = 0;
    if (/\d/.test(t)) strength += 2; // chiffre, durée, volume, ratio
    if (/\bpour\s+[A-ZÀ-Ý]|\bchez\s+[A-ZÀ-Ý]|\bclient\b/i.test(t)) strength += 1; // client nommé, forme directe
    // A parenthetical list of capitalised names ("(Maison Orée, Lune & Sel,
    // Vélo Rivière…)") is how this master CV (and most others) actually names
    // clients or brands — much more often than the direct "pour X"/"chez X"
    // phrasing above, which real agency bullets rarely use.
    if (/\([^)]*[A-ZÀ-Ý][a-zà-ÿ][^)]*\)/.test(t)) strength += 1;
    if (/\b(en\s+interne|interne|mon\s+propre|ma\s+propre)\b/i.test(t)) strength -= 1; // preuve auto-déclarée
    return strength;
  };

  // A tie-break that only fires within a few points of each other has no
  // effect when the model's own scores are 20-30 points apart, which is
  // the common case — that produced exactly the bug this weight fixes
  // (a self-directed automation bullet outscoring a bullet with a real,
  // named-client result). Evidence is instead ADDED to the model's score
  // before sorting: a few points per signal, enough to flip a marginal
  // call, never enough on its own to beat a real, wide score gap (a
  // maximum swing of ~18 points here can't override a 40-point one).
  const EVIDENCE_WEIGHT = 6;
  const effectiveBulletScore = (item) => item.score + evidenceStrength(item.text) * EVIDENCE_WEIGHT;

  /** Highest score first; ties keep their relative (model-given) order. */
  const byScoreDesc = (a, b) => b.score - a.score;

  /** Same ordering, but scored by evidence-weighted score, not raw score —
   *  used for bullets only (rule 2 is about proof behind a bullet, not a
   *  skill line). */
  const byBulletRelevance = (a, b) => effectiveBulletScore(b) - effectiveBulletScore(a);

  const MAX_BULLETS = 4;
  const MIN_BULLETS = 2;
  const MAX_SKILLS = 8;

  /**
   * Tops `picked` up to `target` (capped by what the pool actually has)
   * with unused pool entries, in pool order, skipping any entry `skip`
   * rejects. Appended entries land after the already-picked ones — they
   * are a safety filler, never a challenger to a real model score.
   */
  const topUp = (picked, pool, target, { skip = () => false } = {}) => {
    if (picked.length >= target) return picked;
    const used = new Set(picked.map((p) => p.source));
    const next = picked.slice();
    for (let i = 0; i < pool.length && next.length < target; i++) {
      if (used.has(i) || skip(pool[i])) continue;
      next.push(verbatim(pool, i));
      used.add(i);
    }
    return next;
  };

  const expById = new Map(cv.experiences.map((e) => [e.id, e]));
  const seen = new Set();

  const experiences = ((selection && selection.experiences) || [])
    .filter((e) => {
      if (!e || !expById.has(e.id) || seen.has(e.id)) return false;
      seen.add(e.id);
      return true;
    })
    .map((e) => {
      const pool = expById.get(e.id).realisations || [];
      let picked = (e.bullets || []).map((b) => pick(b, pool)).filter(Boolean);

      // A selection that resolved to nothing (bad indices, empty array) would
      // otherwise fall through to "print the whole pool" further down, which
      // blows the one-page layout. Take the top of the pool verbatim instead.
      if (!picked.length) picked = pool.slice(0, 3).map((_, i) => verbatim(pool, i));

      // Sort by evidence-weighted relevance BEFORE cutting to the page
      // budget — slicing the model's raw array order would keep whichever
      // 4 it listed first, not whichever 4 actually hold up best.
      picked = picked.sort(byBulletRelevance).slice(0, MAX_BULLETS);

      // A displayed experience earns at least two lines when its pool has
      // them: one bullet reads like a placeholder next to a peer with four.
      picked = topUp(picked, pool, MIN_BULLETS);

      return { id: e.id, title: e.titre || undefined, picked };
    });

  // A selection with no experiences at all (very off-target offer) would let
  // the renderer fall back to the master while the verification step saw
  // nothing — unchecked content in the PDF. Materialise the fallback here so
  // what gets rendered is exactly what gets verified.
  if (!experiences.length) {
    cv.experiences.forEach((exp) => {
      const pool = exp.realisations || [];
      experiences.push({
        id: exp.id,
        title: undefined,
        picked: pool.slice(0, 3).map((_, i) => verbatim(pool, i)),
      });
    });
  }

  const skillPool = cv.competences || [];
  let skills = ((selection && selection.competences) || [])
    .map((s) => pick(s, skillPool))
    .filter(Boolean);
  if (!skills.length) skills = skillPool.slice(0, MAX_SKILLS).map((_, i) => verbatim(skillPool, i));
  skills = skills.sort(byScoreDesc).slice(0, MAX_SKILLS);

  // Tool categories are selected whole (no reformulation, unlike bullets/
  // skills), by index into the pool. "Bureautique" is the office-suite
  // category — generic to the point of never differentiating a candidate —
  // so the fallback used whenever the model didn't select at all (an empty
  // or missing "outils") excludes it by construction. An explicit pick that
  // includes it is honoured: that is the model judging the offer actually
  // asked for it.
  const toolPool = cv.outils || [];
  const OFFICE_CATEGORY_RE = /bureautique/i;
  const toolIdx = [...new Set((selection && selection.outils) || [])].filter(
    (i) => Number.isInteger(i) && toolPool[i] !== undefined
  );
  const tools = toolIdx.length
    ? toolIdx.map((i) => toolPool[i])
    : toolPool.filter((t) => !OFFICE_CATEGORY_RE.test(t.label || ''));

  /* ------------------------------------------------------------------ *
   * Angle de profil — choisi par code, pas par le modèle
   *
   * A hybrid offer (e.g. marketing/growth AND AI) needs an angle that
   * holds up on BOTH dimensions, not the angle that maxes out one axis
   * while cratering the other — which is exactly what "ask the model to
   * pick one" invited (an "implementation_ia" angle winning on an offer
   * that also wanted growth, because it scored highest on AI alone).
   *
   * The model scores every candidate angle (default + each proposed) on
   * every dimension the offer actually has. Code picks the angle with the
   * best WORST-of-its-dimension-scores (maximin) — the angle that is
   * least bad on its weakest axis, not the one that peaks highest on one.
   * With a single-dimension offer this reduces to plain highest score.
   *
   * A manual choice (options.angle) bypasses all of it.
   *
   * Whichever angle wins, the profile printed is that angle's master text
   * VERBATIM — never the model's paraphrase, which drifted into claims
   * ("j'accompagne leur adoption") the master never made.
   * ------------------------------------------------------------------ */
  const angleText = (angle) =>
    angle === 'defaut'
      ? cv.profil || ''
      : ((cv.profil_variants || []).find((v) => v.angle === angle) || {}).texte || '';

  const candidates = ((selection && selection.profils) || []).filter(
    (c) => c && Array.isArray(c.scores_dimensions) && c.scores_dimensions.length
  );

  const knownAngles = new Set(['defaut', ...(cv.profil_variants || []).map((v) => v.angle)]);
  const scoredCandidates = candidates
    .filter((c) => knownAngles.has(c.angle) && angleText(c.angle).trim())
    .map((c) => ({
      angle: c.angle,
      // A missing or non-numeric dimension score is treated as 0 (worst
      // case), not skipped — an angle the model didn't bother scoring on
      // a dimension shouldn't win that dimension by omission.
      worst: Math.min(...c.scores_dimensions.map((n) => (Number.isFinite(Number(n)) ? Number(n) : 0))),
    }))
    .sort((a, b) => b.worst - a.worst);

  const manualAngle = options.angle && knownAngles.has(options.angle) && angleText(options.angle).trim()
    ? options.angle
    : null;
  const chosenAngle = manualAngle || (scoredCandidates.length ? scoredCandidates[0].angle : 'defaut');
  const profileText = angleText(chosenAngle);

  // Projects are selected whole, by id, and ordered by the same score the
  // bullets and skills use — never reformulated: a "build" project's
  // description and a "conseil" project's realisations are master facts.
  // No selection at all keeps the master order, so the section never
  // silently empties out when the model skips the field.
  //
  // A project the model marks "retenu": false (typically one its master
  // "contexte" reserves for other kinds of offers) is dropped — listing it
  // with a low score used to be enough to print it anyway.
  //
  // A project filed under "experiences" by mistake (a "conseil" project
  // read as a job) is recovered here rather than silently lost: the
  // experience filter above only knows real experience ids.
  const projectPool = cv.projets || [];
  const projectIds = new Set(projectPool.map((p) => p.id));
  const excludedProjects = new Set();
  const seenProjects = new Set();
  const misfiled = ((selection && selection.experiences) || [])
    .filter((e) => e && projectIds.has(e.id) && !expById.has(e.id))
    .map((e) => {
      const scores = (e.bullets || []).map((b) => toScore(b && b.score)).filter((n) => n >= 0);
      return {
        id: e.id,
        score: scores.length ? Math.max(...scores) : undefined,
        realisations: (e.bullets || []).map((b) => b && b.source),
      };
    });
  let projects = [...((selection && selection.projets) || []), ...misfiled]
    .filter((p) => {
      if (!p || !projectIds.has(p.id) || seenProjects.has(p.id)) return false;
      seenProjects.add(p.id);
      if (p.retenu === false) {
        excludedProjects.add(p.id);
        return false;
      }
      return true;
    })
    .map((p) => ({ id: p.id, score: toScore(p.score), realisations: p.realisations }));
  if (!projects.length) {
    const fallback = projectPool.filter((p) => !excludedProjects.has(p.id));
    projects = fallback.map((p, i) => ({ id: p.id, score: fallback.length - i }));
  }
  projects = projects.sort(byScoreDesc);

  // Where the section sits on the page. "apres_formation" pushes it below
  // education, for offers that read experience first; the default keeps it
  // right after the professional experience, which is where a builder-
  // flavoured offer wants to find it.
  const projectsPosition =
    selection && selection.projets_position === 'apres_formation'
      ? 'apres_formation'
      : 'apres_experience';

  /* ------------------------------------------------------------------ *
   * Cohérence profil ↔ corps du CV
   *
   * The profile is written with the fullest view of the candidate, the
   * body is trimmed for relevance to this offer — nothing stops the two
   * from disagreeing, e.g. the chosen angle naming a project or a company
   * that this offer's own selection then dropped from the page. Rather
   * than editing the profile's prose (fragile, and step 3 would have to
   * re-check it), the body is made to agree with what the profile already
   * claims: a name it mentions gets added back into the body, verbatim.
   * ------------------------------------------------------------------ */
  const consistencyText = profileText;

  /** True when `name` appears as one of its own significant words inside
   *  `text` — "Hestia" still matches a profile that only names "Hestia
   *  Groupe" the once, without the legal-suffix word. Short or generic
   *  words are skipped, too weak a signal to trust on their own. */
  const GENERIC_NAME_WORDS = new Set([
    'groupe', 'group', 'sas', 'sa', 'sarl', 'inc', 'ltd', 'corp', 'corporation',
    'company', 'gmbh', 'srl', 'spa', 'le', 'la', 'les', 'de', 'des', 'du',
    'et', 'and', 'the', 'of', 'pour', 'avec',
  ]);
  const wordAppearsIn = (text, word) => {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b${escaped}\\b`, 'i').test(String(text || ''));
  };
  const nameAppearsIn = (text, name) => {
    const words = String(name || '')
      .split(/\s+/)
      .map((w) => w.trim())
      .filter((w) => w.length >= 4 && !GENERIC_NAME_WORDS.has(w.toLowerCase()));
    return words.length > 0 && words.some((w) => wordAppearsIn(text, w));
  };

  const presentExpIds = new Set(experiences.map((e) => e.id));
  cv.experiences.forEach((exp) => {
    if (presentExpIds.has(exp.id) || !nameAppearsIn(consistencyText, exp.entreprise)) return;
    const pool = exp.realisations || [];
    experiences.push({ id: exp.id, title: undefined, picked: pool.slice(0, 3).map((_, i) => verbatim(pool, i)) });
    presentExpIds.add(exp.id);
  });

  // Force-added projects are tracked separately: the one-page trim (in
  // render.js) cuts the lowest-scored projects first when the page runs
  // long, and a project only here because the profile names it must
  // survive that cut — otherwise the profile would cite something the CV
  // never shows, the exact bug this whole block exists to prevent.
  const requiredProjectIds = new Set();
  const presentProjectIds = new Set(projects.map((p) => p.id));
  projectPool.forEach((proj) => {
    if (presentProjectIds.has(proj.id)) return;
    if (!nameAppearsIn(consistencyText, proj.nom) && !nameAppearsIn(consistencyText, proj.nom_en)) return;
    projects.push({ id: proj.id, score: 0 });
    presentProjectIds.add(proj.id);
    requiredProjectIds.add(proj.id);
  });
  projects = projects.sort(byScoreDesc);

  // Which realisations a "conseil" project prints, by master index — so a
  // "contexte" like "2 réalisations max, la ligne conformité seulement si
  // l'offre en parle" can actually be followed. Printed verbatim, in the
  // order given; invalid or duplicate indices are ignored, and a project
  // with no usable pick falls back to the top of its pool when rendered.
  const projectById = new Map(projectPool.map((p) => [p.id, p]));
  const projectRealisations = {};
  projects.forEach((p) => {
    const proj = projectById.get(p.id);
    if (!proj || proj.type !== 'conseil' || !Array.isArray(p.realisations)) return;
    const size = (proj.realisations || []).length;
    const picks = [];
    p.realisations.forEach((n) => {
      const i = Number(n);
      if (Number.isInteger(i) && i >= 0 && i < size && !picks.includes(i)) picks.push(i);
    });
    if (picks.length) projectRealisations[p.id] = picks.slice(0, MAX_BULLETS);
  });

  /* ------------------------------------------------------------------ *
   * Doublons entre une expérience et un projet affiché
   *
   * A fact belongs on the page once: if a project is shown, an experience
   * bullet that only exists to name-drop that same project restates it,
   * it doesn't add anything. Cut it, and top the experience back up from
   * the rest of its pool so the density floor above still holds.
   * ------------------------------------------------------------------ */
  const shownProjectNames = projects
    .map((p) => projectPool.find((proj) => proj.id === p.id))
    .filter(Boolean)
    .flatMap((proj) => [proj.nom, proj.nom_en])
    .filter((name) => name && String(name).length >= 4);

  if (shownProjectNames.length) {
    const mentionsShownProject = (text) => shownProjectNames.some((name) => nameAppearsIn(text, name));
    experiences.forEach((exp) => {
      const before = exp.picked.length;
      const kept = exp.picked.filter((b) => !mentionsShownProject(b.text));
      if (kept.length === before) return;
      const pool = expById.get(exp.id).realisations || [];
      exp.picked = topUp(kept, pool, before, { skip: mentionsShownProject });
    });
  }

  // Records what actually decided the final bullet order — the model's raw
  // score, the evidence bonus rule 2 adds on top, and the sum used to
  // sort — on every bullet, including ones added after the sort by topUp
  // or the dedupe pass above. This is what /api/rewrite logs server-side:
  // the honest answer to "did the score actually drive the order".
  experiences.forEach((exp) => {
    exp.picked = exp.picked.map((item) => ({
      ...item,
      evidence: evidenceStrength(item.text),
      effectiveScore: effectiveBulletScore(item),
    }));
  });

  // Experiences always print in reverse chronological order (latest start
  // first), whatever their score; an unreadable period sorts last, and a
  // tie keeps the master order.
  const masterRank = new Map(cv.experiences.map((e, i) => [e.id, i]));
  const startOf = new Map(cv.experiences.map((e) => [e.id, periodStart(e.periode)]));
  experiences.sort((a, b) => {
    const sa = startOf.get(a.id);
    const sb = startOf.get(b.id);
    if (sa !== sb) {
      if (sa === null || sa === undefined) return 1;
      if (sb === null || sb === undefined) return -1;
      return sb - sa;
    }
    return masterRank.get(a.id) - masterRank.get(b.id);
  });

  // Builder angles put the "build" projects ahead of the "conseil" ones;
  // each group keeps its score order.
  if (BUILD_FIRST_ANGLES.has(chosenAngle)) {
    const isBuild = (p) => (projectById.get(p.id) || {}).type !== 'conseil';
    projects = [...projects.filter(isBuild), ...projects.filter((p) => !isBuild(p))];
  }

  return {
    summary_rewritten: profileText,
    experiences_rewritten: experiences.map((e) => ({
      id: e.id,
      title: e.title,
      bullets: e.picked.map((p) => p.text),
    })),
    skills_rewritten: skills.map((s) => s.text),
    tools_rewritten: tools,
    projects_rewritten: projects.map((p) => p.id),
    projects_realisations: projectRealisations,
    // Ids the one-page trim (render.js) must never cut, whatever the
    // maxProjects budget — see the consistency block above.
    projects_required: [...requiredProjectIds],
    projects_position: projectsPosition,
    changes_summary: (selection && selection.changes_summary) || [],
    _grounded: {
      profil_angle: chosenAngle,
      profil_angle_source: manualAngle ? 'manuel' : 'auto',
      profil_candidates: scoredCandidates,
      skills,
      experiences,
      projects,
    },
  };
}

function rewrittenCvAsText(rewrite) {
  const L = [];
  L.push('PROFIL:');
  L.push(rewrite.summary_rewritten || '');
  L.push('');
  L.push('COMPÉTENCES:');
  (rewrite.skills_rewritten || []).forEach((s) => L.push(`- ${s}`));
  L.push('');
  L.push('EXPÉRIENCES:');
  (rewrite.experiences_rewritten || []).forEach((exp) => {
    L.push(`${exp.title || exp.id} [${exp.id}]`);
    (exp.bullets || []).forEach((b) => L.push(`  - ${b}`));
  });
  L.push('');
  L.push('OUTILS:');
  (rewrite.tools_rewritten || []).forEach((t) => L.push(`- ${t.label}: ${t.valeur}`));
  return L.join('\n');
}

module.exports = { periodStart, normalizeSelection, rewrittenCvAsText };
