'use strict';

const fs = require('fs');
const { escapeHtml } = require('./util');
const { resolveExperiences, resolveProjects } = require('./masterCv');

const LABELS = {
  fr: {
    profile: 'PROFIL',
    skills: 'COMPÉTENCES CLÉS',
    experience: 'EXPÉRIENCE PROFESSIONNELLE',
    projects: 'PROJETS',
    education: 'FORMATION',
    languages: 'LANGUES',
    tools: 'IA & OUTILS',
    practical: 'INFOS PRATIQUES',
    interests: 'INTÉRÊTS',
    siteCta: 'Voir mon CV en ligne →',
  },
  en: {
    profile: 'PROFILE',
    skills: 'KEY SKILLS',
    experience: 'PROFESSIONAL EXPERIENCE',
    projects: 'PROJECTS',
    education: 'EDUCATION',
    languages: 'LANGUAGES',
    tools: 'AI & TOOLS',
    practical: 'PRACTICAL INFO',
    interests: 'INTERESTS',
    siteCta: 'See my CV online →',
  },
};

/**
 * Translates the tailored (French) CV content to English. This is the ONLY
 * place English text is produced — master-cv.json stays French-only, and
 * the job-offer tailoring from step 2 is preserved through the translation
 * (we translate the rewrite, not the raw master).
 */
async function translateToEnglish(payload, callClaudeJson, translateSystemPrompt) {
  const userPrompt = `Traduis ce CV en anglais professionnel (business English, marché UK/US).
Traduction fidèle : ne change, n'ajoute et ne retire aucun fait, chiffre, nom propre ou outil.
Traduis aussi les noms de mois dans les champs "period" ("Mars 2023" → "March 2023"), sans
toucher aux années ni au format des tirets.
Exception à la règle des noms propres : les noms de villes dans le champ "location" se
traduisent bel et bien en anglais (ex: "Bruxelles" → "Brussels"), contrairement aux noms
d'entreprises, de personnes ou d'outils qui restent inchangés. Une ville qui s'écrit pareil
dans les deux langues (ex: "Paris") ne change évidemment pas.
Dans le champ "valeur" des outils, ne traduis JAMAIS les noms d'outils/produits eux-mêmes
(Claude, ChatGPT, Python, Node.js…) : traduis uniquement les mots descriptifs autour
(ex: "notions RAG" → "RAG basics", "sortie JSON structurée" → "structured JSON output").
Garde exactement la même structure JSON, le même ordre, les mêmes clés et les mêmes "id".

CV à traduire (JSON) :
${JSON.stringify(payload, null, 2)}

Réponds uniquement avec le JSON traduit, structure strictement identique.`;

  return callClaudeJson({ system: translateSystemPrompt, userPrompt, maxTokens: 4000 });
}

const OFFICE_CATEGORY_RE = /bureautique/i;

/* ------------------------------------------------------------------ *
 * Permis — affiché seulement quand l'offre en fait un sujet
 *
 * A driving licence on a CV is dead weight for a desk job and a real
 * signal for a role with travel, field work or a vehicle. The offer
 * decides, and it decides here in code rather than in a prompt: the
 * check has to give the same answer every run.
 *
 * Age is not part of this: it is never printed, whatever the offer says.
 * ------------------------------------------------------------------ */

const LICENCE_SIGNALS = [
  // FR
  /permis\s+(?:b\b|de\s+conduire)/i,
  /d[ée]placements?\b/i,
  /se\s+d[ée]placer/i,
  /sur\s+le\s+terrain\b/i,
  /v[ée]hicule/i,
  /voiture\s+de\s+fonction/i,
  /itin[ée]ran/i,
  /tourn[ée]es?\b/i,
  /mobilit[ée]\s+g[ée]ographique/i,
  // EN
  /driv(?:ing|er'?s)\s+licen[cs]e/i,
  /\btravel(?:ling|ing)?\b/i,
  /on-?site\s+visits?/i,
  /\bfield\s+(?:work|visits?|sales)\b/i,
  /\bcompany\s+car\b/i,
  /\bvehicle\b/i,
];

/** True when the job offer mentions travel, field work or a vehicle. */
function licenceIsRelevant(jobOffer) {
  const text = String(jobOffer || '');
  if (!text.trim()) return false;
  return LICENCE_SIGNALS.some((re) => re.test(text));
}

/**
 * The tool categories to show: the rewrite's own selection when there is
 * one, else every category except "Bureautique" — generic office-suite
 * skills that never differentiate a candidate, so a rewrite that never ran
 * (or selected nothing) should not default to showing them.
 */
function resolveTools(cv, rewrite) {
  if (rewrite && rewrite.tools_rewritten && rewrite.tools_rewritten.length) {
    return rewrite.tools_rewritten;
  }
  return (cv.outils || []).filter((t) => !OFFICE_CATEGORY_RE.test(t.label || ''));
}

/**
 * The personal-site link: shown in the header unless the interface turned
 * it off. Its own function because resolveDisplayProjects (below) needs
 * the same value — the project version of that link is redundant once the
 * header already carries it.
 */
function resolveWebsite(cv, websiteMode) {
  return websiteMode === 'none' ? '' : String((cv.personal && cv.personal.website) || '').trim();
}

/** Strips scheme and trailing slash so a header link and a project link
 *  compare equal regardless of which one carries "https://". */
function normalizeUrl(u) {
  return String(u || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '');
}

/**
 * The projects to actually show: resolveProjects' selection, minus a
 * "personal website" project whose link is the one already sitting in the
 * header. Showing it twice says nothing a reader didn't already have.
 */
function resolveDisplayProjects(cv, rewrite, website) {
  const projects = resolveProjects(cv, rewrite);
  if (!website) return projects;
  return projects.filter((p) => normalizeUrl(p.lien) !== normalizeUrl(website));
}

/**
 * Applies the one-page trim's project count budget while keeping every
 * entry whose project id is in `requiredIds` — those are cited in the
 * profile (rule 3, lib/rewrite.js) and must never be silently cut just
 * because the page ran long, which is exactly how a project the profile
 * names could end up nowhere on the actual CV. Order is preserved; only
 * optional entries past the budget are dropped, and a required entry
 * counts against nothing — it is never the one that gets removed.
 *
 * Operates on `{ proj, i }` pairs (not bare projects) so the original,
 * pre-budget index `i` survives for the translation lookup in
 * buildCvHtml: once entries are filtered non-contiguously, position
 * within the result no longer equals position in `translated.ai_projects`.
 */
function applyProjectBudget(entries, maxProjects, requiredIds) {
  const max = Number.isFinite(maxProjects) ? maxProjects : entries.length;
  if (entries.length <= max) return entries;
  const isRequired = (e) => requiredIds && requiredIds.has(e.proj.id);
  const requiredCount = entries.filter(isRequired).length;
  const optionalBudget = Math.max(0, max - requiredCount);
  let keptOptional = 0;
  return entries.filter((e) => {
    if (isRequired(e)) return true;
    if (keptOptional < optionalBudget) {
      keptOptional++;
      return true;
    }
    return false;
  });
}

/**
 * The title printed under the candidate's name. Always the master's own
 * "titre", never the offer's job title: a CV headed "AI Deployment
 * Strategist" claims a role the candidate never held. It is printed as-is
 * in every language, so it stays out of the translation payload.
 */
function candidateTitle(cv) {
  return cv.titre || cv.experiences[0].titre;
}

/** Builds the FR payload sent for translation, from master + tailored rewrite. */
function buildTranslationPayload(cv, { rewrite, websiteMode }) {
  const resolved = resolveExperiences(cv, rewrite);
  const website = resolveWebsite(cv, websiteMode);
  return {
    profile: (rewrite && rewrite.summary_rewritten) || cv.profil,
    skills:
      (rewrite && rewrite.skills_rewritten && rewrite.skills_rewritten.length
        ? rewrite.skills_rewritten
        : cv.competences) || [],
    experiences: resolved.map((e) => ({
      id: e.id,
      title: e.title,
      type: e.type,
      location: e.lieu,
      period: e.period,
      bullets: e.bullets,
    })),
    education: cv.education.map((ed) => ({
      degree: ed.diplome,
      detail: ed.detail || '',
      period: ed.periode || '',
    })),
    languages: cv.langues.map((lg) => ({ name: lg.nom, level: lg.niveau })),
    tools: resolveTools(cv, rewrite).map((t) => ({ label: t.label, valeur: t.valeur })),
    // Age is deliberately absent: it is never printed, so translating it
    // would only give the PDF a field it must not use.
    personal: {
      dispo: cv.personal.disponibilite || '',
      permis: cv.personal.permis || '',
    },
    interests: cv.interets || [],
    // Same selection and order the renderer will use: the translation is
    // matched back by position, so the two lists have to line up exactly —
    // including the personal-website project dropped when it duplicates
    // the header link (resolveDisplayProjects, not the raw resolveProjects).
    ai_projects: resolveDisplayProjects(cv, rewrite, website).map((p) => ({
      subtitle: p.sousTitre || '',
      description: p.description || '',
      // Translated too: the one-page trim swaps it in for English CVs as well.
      description_short: p.descriptionCourte || '',
      bullets: p.bullets || [],
    })),
  };
}

/**
 * Flattens the translated payload into the claim-carrying lines, each under a
 * ref the fixes can be applied back through. Periods, locations, education,
 * languages and tool names are left out: they carry no claim to overstate.
 */
function translationItems(translated, source) {
  // The French line each English one was translated from, found by the
  // same ref in the French payload. Without it the checker only had a ref
  // like "skill:1" — a position in this CV — and matched it to the master's
  // skill number 1 instead, then "repaired" the line into a duplicate.
  const frByRef = source
    ? new Map(translationItems(source).map((it) => [it.ref, it.en]))
    : new Map();
  const items = [];
  const push = (ref, text) => {
    const en = String(text || '').trim();
    if (!en) return;
    const fr = frByRef.get(ref);
    items.push(fr ? { ref, fr, en } : { ref, en });
  };

  push('profile', translated.profile);
  push('target_title', translated.target_title);
  (translated.skills || []).forEach((s, i) => push(`skill:${i}`, s));
  (translated.experiences || []).forEach((e) => {
    push(`exp:${e.id}:title`, e.title);
    push(`exp:${e.id}:type`, e.type);
    (e.bullets || []).forEach((b, i) => push(`exp:${e.id}:${i}`, b));
  });
  (translated.ai_projects || []).forEach((p, i) => {
    push(`proj:${i}:subtitle`, p.subtitle);
    push(`proj:${i}:description`, p.description);
    push(`proj:${i}:description_short`, p.description_short);
    (p.bullets || []).forEach((b, j) => push(`proj:${i}:${j}`, b));
  });

  return items;
}

const sameLine = (text) =>
  String(text || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[\s.;,:!]+$/, '')
    .trim();

/**
 * Drops any repair that would copy a line already on the CV (another item's
 * English text, or another repair): a "fix" that turns one skill into a
 * second copy of its neighbour loses a line and prints a duplicate. The
 * original translation stands for that ref instead.
 */
function rejectDuplicateFixes(items, fixes) {
  if (!fixes || !fixes.size) return { fixes: fixes || new Map(), rejected: [] };
  const kept = new Map();
  const rejected = [];
  const taken = new Map();
  (items || []).forEach((it) => {
    if (!fixes.has(it.ref)) taken.set(sameLine(it.en), it.ref);
  });
  fixes.forEach((texte, ref) => {
    const key = sameLine(texte);
    const other = taken.get(key);
    if (other && other !== ref) {
      rejected.push({ ref, duplicateOf: other });
      return;
    }
    taken.set(key, ref);
    kept.set(ref, texte);
  });
  return { fixes: kept, rejected };
}

/** Applies a Map<ref, texte> of repaired lines back onto the translated payload. */
function applyTranslationFixes(translated, byRef) {
  if (!byRef || !byRef.size) return translated;
  const next = JSON.parse(JSON.stringify(translated));
  const fix = (ref, apply) => {
    const v = byRef.get(ref);
    if (v) apply(v);
  };

  fix('profile', (v) => { next.profile = v; });
  fix('target_title', (v) => { next.target_title = v; });
  (next.skills || []).forEach((_, i) => fix(`skill:${i}`, (v) => { next.skills[i] = v; }));
  (next.experiences || []).forEach((e) => {
    fix(`exp:${e.id}:title`, (v) => { e.title = v; });
    fix(`exp:${e.id}:type`, (v) => { e.type = v; });
    (e.bullets || []).forEach((_, i) => fix(`exp:${e.id}:${i}`, (v) => { e.bullets[i] = v; }));
  });
  (next.ai_projects || []).forEach((p, i) => {
    fix(`proj:${i}:subtitle`, (v) => { p.subtitle = v; });
    fix(`proj:${i}:description`, (v) => { p.description = v; });
    fix(`proj:${i}:description_short`, (v) => { p.description_short = v; });
    (p.bullets || []).forEach((_, j) => fix(`proj:${i}:${j}`, (v) => { p.bullets[j] = v; }));
  });

  return next;
}

/** Keep only the requested variant block of the template. */
function selectVariant(template, format) {
  const keep = format === 'ats' ? 'ATS' : 'DESIGN';
  const drop = keep === 'ATS' ? 'DESIGN' : 'ATS';
  const dropRe = new RegExp(`<!--\\s*VARIANT:${drop}\\s*-->[\\s\\S]*?<!--\\s*/VARIANT:${drop}\\s*-->`, 'g');
  return template
    .replace(dropRe, '')
    .replace(new RegExp(`<!--\\s*/?VARIANT:${keep}\\s*-->`, 'g'), '');
}

const A4_HEIGHT_PX = (297 * 96) / 25.4; // one A4 page at 96dpi, ≈ 1122.5px

/**
 * How much overflow still counts as fitting. Almost none: Chrome starts a
 * second page on a fraction of a pixel, and this check used to allow a
 * whole one — which is how a page measured at 1123.3px was called a fit
 * and came out of the printer as two pages. Only float noise is tolerated.
 */
const FIT_TOLERANCE_PX = 0.05;

/* ------------------------------------------------------------------ *
 * Une page, garantie
 *
 * Shrinking the type is the last resort, not the first: a CV that fits
 * because it is unreadable has not fitted. So content goes first, and it
 * goes in order of what costs the candidacy least — interests before a
 * bullet, a project's short description before the project itself.
 *
 * Every level is a complete state, not a diff, so "level 4" renders the
 * same page whatever path led there. Bullets, skills and projects all
 * arrive already sorted by relevance (step 2 scores them), so trimming is
 * always a slice off the tail: the lowest-scored item goes first.
 *
 * Trimming only ever REMOVES content that step 3 already checked — it
 * never rewrites or adds, so the fact-checking still holds afterwards.
 * ------------------------------------------------------------------ */

const TRIM_PLAN = [
  {},
  { hideInterests: true },
  { hideInterests: true, shortProjects: true },
  { hideInterests: true, shortProjects: true, maxBullets: 3 },
  { hideInterests: true, shortProjects: true, maxBullets: 3, maxSkills: 7 },
  { hideInterests: true, shortProjects: true, maxBullets: 3, maxSkills: 6, maxProjects: 3 },
  { hideInterests: true, shortProjects: true, maxBullets: 2, maxSkills: 6, maxProjects: 2 },
  { hideInterests: true, shortProjects: true, maxBullets: 2, maxSkills: 5, maxProjects: 1 },
];

/** Plain-language trace of what a trim level gave up, for the UI. */
function describeTrim(trim) {
  const parts = [];
  if (trim.hideInterests) parts.push('intérêts masqués');
  if (trim.shortProjects) parts.push('projets en version courte');
  if (trim.maxBullets) parts.push(`${trim.maxBullets} réalisations par expérience`);
  if (trim.maxSkills) parts.push(`${trim.maxSkills} compétences`);
  if (trim.maxProjects) parts.push(`${trim.maxProjects} projet(s)`);
  return parts.join(', ');
}

/**
 * The design layout is tuned to fit one page, but an AI rewrite can produce
 * longer bullets than the reference content. Shrink the page with CSS `zoom`
 * until it fits, down to a readability floor.
 *
 * Measure with getBoundingClientRect(), not scrollHeight: `zoom` rescales the
 * rendered box but leaves an element's own scrollHeight in its pre-zoom
 * coordinate space, so scrollHeight never converges.
 */
async function fitOnePage(page, minZoom = 0.7) {
  const MIN_ZOOM = minZoom;
  const measure = () =>
    page.evaluate(() => document.querySelector('.page').getBoundingClientRect().height);
  const apply = (z) =>
    page.evaluate((v) => {
      document.querySelector('.page').style.setProperty('--fit', String(v));
    }, z);

  let zoom = 1;
  let height = await measure();
  if (height <= A4_HEIGHT_PX + FIT_TOLERANCE_PX) return { zoom, fitted: true };

  for (let i = 0; i < 12 && zoom > MIN_ZOOM; i++) {
    // Aim straight at the required ratio, then ease down if reflow costs a little more.
    const target = Math.max(MIN_ZOOM, +(zoom * (A4_HEIGHT_PX / height) - 0.005).toFixed(3));
    zoom = target === zoom ? +(zoom - 0.02).toFixed(3) : target;
    await apply(zoom);
    height = await measure();
    if (height <= A4_HEIGHT_PX + FIT_TOLERANCE_PX) return { zoom, fitted: true };
  }
  return { zoom, fitted: height <= A4_HEIGHT_PX + FIT_TOLERANCE_PX };
}

/**
 * Renders the CV at successively tighter trim levels until the page fits,
 * and only then shrinks the type — down to a floor, never below it.
 *
 * `renderHtml(trim)` must return the full HTML for that trim level; the
 * caller keeps ownership of everything else (master CV, rewrite, language).
 * Returns the level that was used, so the UI can say what was given up.
 */
async function fitToOnePage(page, renderHtml, { minZoom = 0.7 } = {}) {
  const measure = () =>
    page.evaluate(() => document.querySelector('.page').getBoundingClientRect().height);

  let trim = TRIM_PLAN[0];
  let level = 0;

  for (let i = 0; i < TRIM_PLAN.length; i++) {
    trim = TRIM_PLAN[i];
    level = i;
    // 'load', not 'networkidle0': a second setContent on the same page
    // never reaches network-idle in Puppeteer, so the whole fitting loop
    // would hang the moment a CV actually needed trimming. Nothing here
    // fetches anyway — styles are inline and the photo is a data URI.
    await page.setContent(renderHtml(trim), { waitUntil: 'load', timeout: 30000 });
    const height = await measure();
    if (height <= A4_HEIGHT_PX + FIT_TOLERANCE_PX) {
      return { level, trim, zoom: 1, fitted: true };
    }
  }

  // Everything that could be cut has been cut and it still runs long:
  // shrink the last rendered layout, as far as readability allows.
  const { zoom, fitted } = await fitOnePage(page, minZoom);
  return { level, trim, zoom, fitted };
}

function buildCvHtml(cv, { format, rewrite, lang, translated, websiteMode, jobOffer, trim, templatePath }) {
  const p = cv.personal;
  // How much content this render is allowed to keep (see TRIM_PLAN).
  const cut = trim || {};
  const labels = LABELS[lang] || LABELS.fr;
  const isAts = format === 'ats';
  const useEn = lang === 'en' && translated;
  // Un seul site personnel : le lien s'affiche ou pas, piloté depuis l'interface.
  const website = resolveWebsite(cv, websiteMode);

  const resolved = resolveExperiences(cv, rewrite);
  const translatedById = new Map(((useEn && translated.experiences) || []).map((e) => [e.id, e]));

  const resolvedExperiences = resolved.map((e) => {
    const t = translatedById.get(e.id);
    if (!t) return e;
    return {
      ...e,
      title: t.title || e.title,
      bullets: t.bullets && t.bullets.length ? t.bullets : e.bullets,
      period: t.period || e.period,
      meta: [e.entreprise, t.location || e.lieu, t.type || e.type].filter(Boolean).join(' · '),
    };
  });

  const summary = useEn && translated.profile ? translated.profile : (rewrite && rewrite.summary_rewritten) || cv.profil;

  const skillsFr =
    (rewrite && rewrite.skills_rewritten && rewrite.skills_rewritten.length
      ? rewrite.skills_rewritten
      : (cv.competences || []).slice(0, 8)) || [];
  const allSkills = useEn && translated.skills && translated.skills.length ? translated.skills : skillsFr;
  // The design sidebar is the tallest column: past ~8 entries it, not the
  // main column, is what forces the whole page to shrink. The reference
  // layout runs 7–8. ATS is single-column and has no such constraint.
  const skillBudget = Math.min(cut.maxSkills || Infinity, isAts ? Infinity : 8);
  const skills = Number.isFinite(skillBudget) ? allSkills.slice(0, skillBudget) : allSkills;

  const targetTitle = candidateTitle(cv);

  const toolEntries = resolveTools(cv, rewrite).map((t, i) => {
    const tt = useEn && translated.tools && translated.tools[i];
    return { label: (tt && tt.label) || t.label, value: (tt && tt.valeur) || t.valeur };
  });

  const languageEntries = cv.langues.map((lg, i) => {
    const tl = useEn && translated.languages && translated.languages[i];
    return { name: (tl && tl.name) || lg.nom, level: (tl && tl.level) || lg.niveau };
  });

  const educationEntries = cv.education.map((ed, i) => {
    const te = useEn && translated.education && translated.education[i];
    return {
      degree: (te && te.degree) || ed.diplome,
      school: ed.ecole,
      period: (te && te.period) || ed.periode,
      detail: (te && te.detail) || ed.detail || '',
    };
  });

  // Ids the profile cites (rule 3) — the trim budget below must not cut
  // them, whatever the page's maxProjects level.
  const requiredProjectIds = new Set((rewrite && rewrite.projects_required) || []);

  // Carries each project's ORIGINAL index (into the full, unsliced list
  // translateToEnglish saw) through the budget filter, since a required
  // entry can survive past a gap left by a cut optional one — position in
  // the final array no longer equals position in translated.ai_projects.
  const indexedProjects = resolveDisplayProjects(cv, rewrite, website).map((proj, i) => ({ proj, i }));
  const aiProjectEntries = applyProjectBudget(indexedProjects, cut.maxProjects, requiredProjectIds).map(({ proj, i }) => {
    const tp = useEn && translated.ai_projects && translated.ai_projects[i];
    return {
      // Le nom anglais est une donnée fixe du master (nom_en), jamais une
      // sortie du LLM de traduction — comme un champ [FIXE].
      name: useEn && proj.nomEn ? proj.nomEn : proj.nom,
      subtitle: (tp && tp.subtitle) || proj.sousTitre || '',
      // Under the one-page trim the short description replaces the full
      // one, in either language (translated with the rest in English).
      description:
        cut.shortProjects && proj.descriptionCourte
          ? (useEn && tp && tp.description_short) || proj.descriptionCourte
          : (tp && tp.description) || proj.description || '',
      bullets: (tp && tp.bullets && tp.bullets.length) ? tp.bullets : proj.bullets || null,
      lien: proj.lien || null,
    };
  });

  // "Paris, Île-de-France" → "Paris" in the header, "Paris · Île-de-France" in
  // the practical-info block, mirroring the reference layouts.
  const locationShort = String(p.location || '').split(',')[0].trim();
  const locationDotted = String(p.location || '').replace(/,\s*/g, ' · ');

  const tPersonal = useEn && translated.personal;
  const dispo = (tPersonal && tPersonal.dispo) || p.disponibilite || '';
  // Never the age, and the licence only when this offer asks for it.
  const licence = licenceIsRelevant(jobOffer)
    ? (tPersonal && tPersonal.permis) || p.permis || ''
    : '';
  const interests = useEn && translated.interests && translated.interests.length ? translated.interests : (cv.interets || []);

  // A project's link is the proof it exists — shown whenever the master
  // carries one, in both variants (an ATS parses the href fine, and a human
  // reader can click it).
  const projectLinkHtml = (proj) => {
    const raw = String(proj.lien || '').trim();
    if (!raw) return '';
    const href = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    const label = raw.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
    return `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`;
  };

  // The design column has always run 3 bullets; ATS can take 4. A trim
  // level lowers either, never raises it.
  const bulletBudget = Math.min(cut.maxBullets || Infinity, isAts ? 4 : 3);

  let experiencesHtml;
  let aiProjectsHtml;
  let educationHtml;
  let skillsList;
  let languagesHtml;
  let toolsHtml;
  let practicalHtml;

  if (isAts) {
    experiencesHtml = resolvedExperiences
      .map(
        (e) => `  <div class="exp">
    <div class="exp-title">${escapeHtml(e.title)}</div>
    <div class="exp-meta">${escapeHtml([e.meta, e.period].filter(Boolean).join(' · '))}</div>
    <ul class="bullets">
${e.bullets.slice(0, bulletBudget).map((b) => `      <li>— ${escapeHtml(b)}</li>`).join('\n')}
    </ul>
  </div>`
      )
      .join('\n');

    aiProjectsHtml = aiProjectEntries
      .map((proj) => {
        const heading = proj.subtitle ? `${proj.name} — ${proj.subtitle}` : proj.name;
        const items = (proj.bullets && proj.bullets.length ? proj.bullets : [proj.description]).slice(
          0,
          bulletBudget
        );
        const link = projectLinkHtml(proj);
        return `  <div class="exp">
    <div class="exp-title">${escapeHtml(heading)}</div>
${link ? `    <div class="exp-meta">${link}</div>\n` : ''}    <ul class="bullets">
${items.map((b) => `      <li>— ${escapeHtml(b)}</li>`).join('\n')}
    </ul>
  </div>`;
      })
      .join('\n');

    educationHtml = educationEntries
      .map(
        (ed) => `  <div class="edu">
    <div class="edu-title">${escapeHtml(ed.degree)}</div>
    <div class="edu-meta">${escapeHtml([ed.school, ed.period].filter(Boolean).join(' · '))}</div>
    <div class="edu-detail">${escapeHtml(ed.detail)}</div>
  </div>`
      )
      .join('\n');

    skillsList = `  <div class="skills-line">${skills.map(escapeHtml).join(' · ')}</div>`;
    languagesHtml = `  <div class="skills-line">${languageEntries
      .map((l) => escapeHtml(`${l.name} — ${l.level}`))
      .join(' · ')}</div>`;
    toolsHtml = toolEntries
      .map(
        (t) =>
          `  <div class="tool-row"><b>${escapeHtml(t.label)} :</b> ${escapeHtml(t.value)}</div>`
      )
      .join('\n');
    practicalHtml = `  <div class="skills-line">${escapeHtml(
      [locationDotted, licence].filter(Boolean).join(' · ')
    )}</div>`;
  } else {
    experiencesHtml = resolvedExperiences
      .map(
        (e) => `          <div class="exp">
            <div class="exp-title">${escapeHtml(e.title)}</div>
            <div class="exp-company">${escapeHtml(e.meta)}</div>
            <div class="exp-period">${escapeHtml(e.period)}</div>
            <ul class="exp-ul">
${e.bullets.slice(0, bulletBudget).map((b) => `              <li class="exp-li">— ${escapeHtml(b)}</li>`).join('\n')}
            </ul>
          </div>`
      )
      .join('\n');

    // In the main column the projects get the room the sidebar never had,
    // so they run at full description and reuse the experience markup.
    aiProjectsHtml = aiProjectEntries
      .map((proj) => {
        const items = (proj.bullets && proj.bullets.length ? proj.bullets : [proj.description]).slice(
          0,
          bulletBudget
        );
        const link = projectLinkHtml(proj);
        return `          <div class="exp">
            <div class="exp-title">${escapeHtml(proj.name)}</div>
            <div class="exp-company">${escapeHtml(proj.subtitle)}</div>
${link ? `            <div class="exp-link">${link}</div>\n` : ''}            <ul class="exp-ul">
${items.map((b) => `              <li class="exp-li">— ${escapeHtml(b)}</li>`).join('\n')}
            </ul>
          </div>`;
      })
      .join('\n');

    educationHtml = educationEntries
      .map(
        (ed) => `          <div class="edu">
            <div class="edu-degree">${escapeHtml(ed.degree)}</div>
            <div class="edu-school">${escapeHtml(ed.school)}</div>
            <div class="edu-period">${escapeHtml(ed.period)}</div>
            <div class="edu-detail">${escapeHtml(ed.detail)}</div>
          </div>`
      )
      .join('\n');

    skillsList = `        <ul class="sb-list">
${skills.map((s) => `          <li>• ${escapeHtml(s)}</li>`).join('\n')}
        </ul>`;

    languagesHtml = `        <div class="sb-langs">
${languageEntries
  .map(
    (l) => `          <div><div class="sb-lang-name">${escapeHtml(
      l.name
    )}</div><div class="sb-lang-lvl">${escapeHtml(l.level)}</div></div>`
  )
  .join('\n')}
        </div>`;

    toolsHtml = `        <div class="sb-tools">
${toolEntries
  .map(
    (t) => `          <div><div class="sb-tool-title">${escapeHtml(
      t.label.toUpperCase()
    )}</div><div class="sb-tool-val">${escapeHtml(t.value)}</div></div>`
  )
  .join('\n')}
        </div>`;

    practicalHtml = `        <div class="sb-infos">
          <span>${escapeHtml(locationDotted)}</span>
          ${licence ? `<span>${escapeHtml(licence)}</span>` : ''}
          <span class="sb-dispo">${escapeHtml(dispo)}</span>
        </div>`;
  }

  /* ---------------------------------------------------------------- *
   * Position de la section Projets
   *
   * Two slots, one filled: right after the professional experience (the
   * default, and where an offer that values building and prototyping wants
   * to find the projects), or below education, for an offer that reads
   * experience first and treats side projects as a footnote.
   * ---------------------------------------------------------------- */
  const projectsSection = aiProjectsHtml.trim()
    ? isAts
      ? `  <h2>${labels.projects}</h2>\n${aiProjectsHtml}`
      : `      <div class="m-sec">
        <div class="m-sec-title">${labels.projects}</div>
        <div class="exps">
${aiProjectsHtml}
        </div>
      </div>`
    : '';

  const projectsBelowEducation =
    rewrite && rewrite.projects_position === 'apres_formation';

  const interestsBlock =
    !isAts && !cut.hideInterests && interests.length
      ? `      <div>
        <div class="sb-sec-title">${labels.interests}</div>
        <ul class="sb-list">
${interests.map((i) => `          <li>• ${escapeHtml(i)}</li>`).join('\n')}
        </ul>
      </div>`
      : '';

  // Photo is design-only — the ATS variant stays image-free for parsers.
  const photoHtml =
    !isAts && p.photo
      ? `<div class="h-photo"><img src="${escapeHtml(p.photo)}" alt="${escapeHtml(p.name)}"></div>`
      : '';

  // Design puts the website on its own line under the availability badge.
  const siteLine =
    !isAts && website
      ? `<div class="h-site"><a href="https://${escapeHtml(website)}">${escapeHtml(
          labels.siteCta
        )}</a></div>`
      : '';

  // ATS keeps the website inline in the contacts line.
  const contactsLine = [
    escapeHtml(p.email),
    escapeHtml(p.phone),
    escapeHtml(locationShort),
    `<a href="https://www.${escapeHtml(p.linkedin)}">${escapeHtml(p.linkedin)}</a>`,
    website ? `<a href="https://${escapeHtml(website)}">${escapeHtml(website)}</a>` : '',
  ]
    .filter(Boolean)
    .join(' &nbsp;·&nbsp; ');

  const values = {
    NAME: escapeHtml(p.name),
    TARGET_TITLE: escapeHtml(targetTitle),
    EMAIL: escapeHtml(p.email),
    PHONE: escapeHtml(p.phone),
    LOCATION: escapeHtml(p.location),
    LOCATION_SHORT: escapeHtml(locationShort),
    LINKEDIN: escapeHtml(p.linkedin),
    WEBSITE: escapeHtml(website),
    CONTACTS_LINE: contactsLine,
    DISPO: escapeHtml(dispo),
    PHOTO_HTML: photoHtml,
    SITE_LINE: siteLine,
    SUMMARY: escapeHtml(summary),
    SKILLS_LIST: skillsList,
    EXPERIENCES_HTML: experiencesHtml,
    PROJECTS_AFTER_EXPERIENCE: projectsBelowEducation ? '' : projectsSection,
    PROJECTS_AFTER_EDUCATION: projectsBelowEducation ? projectsSection : '',
    EDUCATION_HTML: educationHtml,
    LANGUAGES_HTML: languagesHtml,
    TOOLS_HTML: toolsHtml,
    PRACTICAL_HTML: practicalHtml,
    INTERESTS_BLOCK: interestsBlock,
    LANG: lang,
    DATE: new Date().toISOString().slice(0, 10),
    FORMAT: isAts ? 'ats' : 'design',
    L_PROFILE: labels.profile,
    L_SKILLS: labels.skills,
    L_EXPERIENCE: labels.experience,
    L_PROJECTS: labels.projects,
    L_EDUCATION: labels.education,
    L_LANGUAGES: labels.languages,
    L_TOOLS: labels.tools,
    L_PRACTICAL: labels.practical,
    L_INTERESTS: labels.interests,
  };

  let html = selectVariant(fs.readFileSync(templatePath, 'utf8'), format);
  for (const [key, value] of Object.entries(values)) {
    html = html.split(`{{${key}}}`).join(value);
  }
  return html;
}

module.exports = {
  LABELS,
  licenceIsRelevant,
  translateToEnglish,
  buildTranslationPayload,
  resolveTools,
  resolveWebsite,
  resolveDisplayProjects,
  applyProjectBudget,
  translationItems,
  rejectDuplicateFixes,
  applyTranslationFixes,
  selectVariant,
  A4_HEIGHT_PX,
  FIT_TOLERANCE_PX,
  TRIM_PLAN,
  describeTrim,
  fitOnePage,
  fitToOnePage,
  buildCvHtml,
};
