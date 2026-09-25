'use strict';

require('dotenv').config();

const express = require('express');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const Anthropic = require('@anthropic-ai/sdk');

const { slugify, todayStamp, pdfPageCount } = require('./lib/util');
const { createMasterCvStore, buildMasterCvText, groundMissingKeywords } = require('./lib/masterCv');
const { createApplicationsStore } = require('./lib/applications');
const { createGenerationsStore } = require('./lib/generations');
const {
  TRANSLATE_SYSTEM_PROMPT,
  createClaudeService,
  openSse,
  sse,
  parseModelJson,
} = require('./lib/claude');
const {
  runFactChecks,
  changedPairs,
  semanticFactCheck,
  repairViolations,
  verifyTranslation,
  repairTranslation,
  resolutionFor,
} = require('./lib/verify');
const { normalizeSelection, rewrittenCvAsText } = require('./lib/rewrite');
const {
  translateToEnglish,
  buildTranslationPayload,
  translationItems,
  rejectDuplicateFixes,
  applyTranslationFixes,
  fitOnePage,
  fitToOnePage,
  describeTrim,
  buildCvHtml,
} = require('./lib/render');

const PORT = process.env.PORT || 3000;
const MODEL = 'claude-sonnet-4-6';

const ROOT = __dirname;
const OUTPUTS_DIR = path.join(ROOT, 'outputs');
const MASTER_CV_PATH = path.join(ROOT, 'master-cv.json');
const MASTER_CV_EXAMPLE_PATH = path.join(ROOT, 'master-cv.example.json');
const APPLICATIONS_PATH = path.join(ROOT, 'applications.json');
const GENERATIONS_PATH = path.join(ROOT, 'generations.json');
const TEMPLATE_PATH = path.join(ROOT, 'templates', 'cv-template.html');

// outputs/ must exist on startup
fs.mkdirSync(OUTPUTS_DIR, { recursive: true });

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const { streamClaude, callClaudeJson, callClaudeTool, friendlyError } = createClaudeService({ anthropic, model: MODEL });
const { activeMasterCvPath, readMasterCvRaw, readMasterCv, writeMasterCv } = createMasterCvStore(MASTER_CV_PATH, {
  fallbackPath: MASTER_CV_EXAMPLE_PATH,
});
const { readApplications, addApplication, updateApplication } = createApplicationsStore(APPLICATIONS_PATH);
const { listGenerations, getGeneration, addGeneration } = createGenerationsStore(GENERATIONS_PATH);

const app = express();
app.use(express.json({ limit: '4mb' }));
app.use(express.static(path.join(ROOT, 'public')));

/**
 * Diagnostic for rules 1 and 2 (bloc 12) — printed after every /api/rewrite
 * so the actual scores behind a selection can be checked, not guessed at:
 * which profile angle won and on what worst-dimension score, and for every
 * experience, each kept bullet's raw model score, evidence bonus and the
 * effective score the sort actually used.
 */
function logRewriteScores(rewrite) {
  const g = rewrite._grounded || {};
  const candidates = (g.profil_candidates || [])
    .map((c) => `${c.angle}(pire=${c.worst})`)
    .join(', ');
  console.log(
    `[rewrite:angle] retenu="${g.profil_angle}" (${g.profil_angle_source}) — candidats notés : ${candidates || '(aucun)'}`
  );

  (g.experiences || []).forEach((exp) => {
    console.log(`[rewrite:bullets] ${exp.id}:`);
    exp.picked.forEach((b) => {
      console.log(
        `  score=${b.score} preuve=${b.evidence >= 0 ? '+' : ''}${b.evidence} effectif=${b.effectiveScore} — ${b.text}`
      );
    });
  });
}

/**
 * Same filename shape whether the PDF comes straight out of the pipeline
 * or from the edited preview — the export step needs it too, and a
 * mismatch here is exactly how two runs of the same offer start
 * overwriting each other's PDF.
 */
function buildPdfFilename(cv, { analysis, format, lang }) {
  const roleSlug = slugify((analysis && analysis.role_title) || 'CV', 'Poste');
  const companySlug = slugify((analysis && analysis.company_name) || 'Entreprise', 'Entreprise');
  const formatSlug = format === 'ats' ? 'ATS' : 'DESIGN';
  const nameSlug = slugify(cv.personal.name, 'CV');
  return `${nameSlug}_${roleSlug}_${companySlug}_${formatSlug}_${String(
    lang || 'fr'
  ).toUpperCase()}_${todayStamp()}.pdf`;
}

/**
 * The "contexte" lines of the master CV are the candidate's own
 * instructions. Step 2 used to be the only step told about them, so step 1
 * kept recommending exactly what they forbid ("valoriser le projet Hestia
 * comme expérience de conseil") and step 2 then followed its advice.
 */
const CONTEXTE_RULE = `CONTEXTE — CONSIGNES IMPÉRATIVES : chaque ligne "contexte:" du CV master
est une consigne du candidat, pas une information d'ambiance. Elle s'applique à
TOUT ce que tu produis : score, justification, signaux d'alerte, corrections
proposées, mots-clés, formulations, résumé des changements. En particulier :
- un projet décrit comme "projet d'école" ne se présente jamais comme une
  expérience professionnelle, et ne se "repositionne" jamais comme tel ;
- un périmètre qui est celui du Groupe client (ex : un nombre de pays) n'est
  jamais présenté comme le périmètre du travail réalisé ;
- une restriction ("ne pas chiffrer", "pas du code") vaut aussi pour tes
  recommandations : ne propose jamais une correction qu'elle interdit ;
- une consigne de périmètre ("à ne retenir que pour des offres liées à…") est
  une condition de sélection : si l'offre n'entre pas dans ce périmètre, le
  projet n'est ni retenu, ni recommandé, ni cité.`;

/* ------------------------------------------------------------------ *
 * Step 1 — Score & Analyse
 * ------------------------------------------------------------------ */

app.post('/api/analyze', async (req, res) => {
  const { jobOffer } = req.body || {};
  openSse(res);

  try {
    if (!process.env.ANTHROPIC_API_KEY) throw Object.assign(new Error('missing key'), { status: 401 });
    if (!jobOffer || !String(jobOffer).trim()) {
      sse(res, 'error', { message: "Colle d'abord une offre d'emploi." });
      return res.end();
    }

    const cv = readMasterCv();
    const masterCvText = buildMasterCvText(cv);

    sse(res, 'status', { message: 'Analyse du CV face à l’offre…' });

    const cachedPrefix = `Voici mon CV master :\n${masterCvText}`;

    const userPrompt = `Voici l'offre d'emploi :
${jobOffer}

Mets-toi à la place du recruteur qui reçoit ce CV pour CE poste précis : tu as 200 CVs à trier
et 10 secondes par CV. Le score doit refléter la probabilité RÉELLE d'un appel, pas une note de
politesse — sois exigeant.

${CONTEXTE_RULE}

MOTS-CLÉS — tu ne recommandes JAMAIS d'ajouter au CV un mot-clé de l'offre qu'aucune
réalisation du master ne prouve. Pour chaque mot-clé de l'offre absent du CV :
- si une réalisation précise du master décrit réellement ce travail, mets-le dans
  "missing_keywords" avec la référence de cette réalisation : "<id>/<numéro>" pour une
  réalisation d'expérience ou de projet "conseil", "<id>" pour un projet "build" ;
- sinon, c'est un écart réel : mets-le dans "keyword_gaps", jamais dans "missing_keywords".
Les corrections des signaux d'alerte obéissent à la même règle : elles ne proposent
jamais d'afficher une compétence, une expérience ou un périmètre que le master ne prouve pas.

CORRECTIONS ("fix") — elles ne s'appuient que sur ce que le master écrit :
- jamais de chiffre à trous ni de résultat à compléter ("de X à Y", "+X %",
  "N clients") : si le master ne donne pas le chiffre, la correction n'en suggère pas ;
- aucun qualificatif absent du master, ni dans "flag" ni dans "fix" (ex : ne
  qualifie pas une startup d'"échouée", un stage de "mineur", un projet de
  "succès") : décris les faits avec les mots du master.

Réponds en JSON strict :
{
  "score": <number 0-100>,
  "score_justification": "<2 phrases max : pourquoi ce candidat serait, ou ne serait pas, rappelé pour ce poste>",
  "missing_keywords": [
    {"mot_cle": "<mot-clé de l'offre>", "source": "<id>/<numéro> ou <id> de la réalisation qui le prouve"}
  ],
  "keyword_gaps": ["<mot-clé de l'offre qu'aucune réalisation du master ne prouve>"],
  "red_flags": [
    {"flag": "<signal qui ferait hésiter un recruteur pressé, visible en 10 sec>", "fix": "<correction concrète>"},
    {"flag": "...", "fix": "..."},
    {"flag": "...", "fix": "..."}
  ],
  "company_name": "<nom de l'entreprise tel qu'il apparaît dans l'offre>",
  "role_title": "<intitulé du poste, lisible et correctement capitalisé — sert au nom du fichier et au suivi, PAS un slug>",
  "tone": "<startup|corporate|agence|luxe|conseil>",
  "ats_format_recommended": <true si grande boîte/ATS, false si agence/startup>
}`;

    const raw = await streamClaude({ res, userPrompt, cachedPrefix, maxTokens: 4000 });
    const parsed = parseModelJson(res, raw);
    if (!parsed) return;

    sse(res, 'done', { result: groundMissingKeywords(cv, parsed) });
    res.end();
  } catch (err) {
    console.error('[analyze]', err);
    sse(res, 'error', { message: friendlyError(err) });
    res.end();
  }
});

/* ------------------------------------------------------------------ *
 * Step 2 — Sélection & adaptation (grounded)
 * ------------------------------------------------------------------ */

app.post('/api/rewrite', async (req, res) => {
  const { analysis, angle } = req.body || {};
  openSse(res);

  try {
    if (!analysis) {
      sse(res, 'error', { message: "L'étape 1 doit être terminée avant la sélection." });
      return res.end();
    }

    const cv = readMasterCv();
    const masterCvText = buildMasterCvText(cv);
    const redFlags = (analysis.red_flags || [])
      .map((f) => `${f.flag} → ${f.fix}`)
      .join(' | ');

    sse(res, 'status', { message: 'Sélection et adaptation des éléments du CV…' });

    // Byte-identical to the cachedPrefix in /api/analyze, and both go
    // through streamClaude with the same SYSTEM_PROMPT and no tools — the
    // full prefix Anthropic hashes matches, so this reuses the cache entry
    // step 1 already created instead of writing a new one. (answer-question
    // and cover-letter below use their own system prompt and tool schema
    // each, so they can't share this entry — only repeat calls to
    // themselves.)
    const cachedPrefix = `Voici mon CV master :\n${masterCvText}`;

    const userPrompt = `Les compétences et réalisations ci-dessus sont numérotées : sélectionne-les par numéro.

Analyse de l'étape 1 :
- Score actuel : ${analysis.score}/100
- Mots-clés manquants (chacun prouvé par une réalisation du master) : ${(analysis.missing_keywords || []).join(', ')}
- Écarts réels, que le master ne prouve pas — ne les ajoute NULLE PART : ${(analysis.keyword_gaps || []).join(', ') || '(aucun)'}
- Signaux d'alerte : ${redFlags}
- Ton de l'entreprise : ${analysis.tone}

LANGUE — IMPÉRATIF : réponds intégralement en FRANÇAIS, même si l'offre est
rédigée en anglais. Le CV master est français et la traduction est une étape
ultérieure et séparée. Un texte anglais produit ici serait traduit deux fois
et échouerait au contrôle factuel.

TA TÂCHE — SÉLECTIONNER, PAS INVENTER.
Tu ne rédiges pas un CV à partir de rien. Tu choisis, dans les réserves
numérotées ci-dessus, les éléments qui servent le mieux CETTE offre, et tu
peux ajuster leur formulation pour coller au vocabulaire de l'offre.

Chaque élément que tu renvoies doit indiquer le numéro dont il provient.
Un élément dont le texte final affirme quelque chose que sa source n'affirme
pas sera rejeté automatiquement à l'étape suivante — donc :

INTERDIT dans une formulation ajustée, sauf si c'est déjà dans la source :
- tout chiffre, pourcentage, durée, volume, montant ;
- tout résultat ou impact mesuré ("réduisant les délais", "augmentant la
  conversion") ;
- tout outil, techno, client, périmètre ou responsabilité absent de la source ;
- toute montée en grade implicite (un stage ne devient pas un poste cadre,
  une contribution ne devient pas un pilotage complet).

Ajuster veut dire : reformuler, raccourcir, choisir un synonyme du métier,
mettre en avant l'angle pertinent. Jamais ajouter un fait.

STYLE — impératif : aucun tiret cadratin ni tiret expressif ("—") dans tes
reformulations. Une bullet ne connecte pas deux idées par un tiret ("fait
X — impact Y") ; elle les relie par une virgule, un "en" ou "avec", ou elle
les sépare en deux phrases courtes.

${CONTEXTE_RULE}
Si un signal d'alerte de l'étape 1 propose une correction contraire à ces consignes,
ignore la correction.

CE QUE TU NE TOUCHES PAS :
- Les intitulés marqués [TITRE VERROUILLÉ] : ne propose pas de "titre" pour
  ces expériences, il sera ignoré.
- Les dates, entreprises, diplômes : ils sont repris automatiquement.

OBJECTIF — DÉCROCHER L'APPEL. Un recruteur décide en 10 secondes :
1. ANGLE DE PROFIL — le choix final se fait PAR CODE, pas par toi, précisément
   pour éviter qu'une offre hybride se retrouve avec un angle qui brille sur
   UN seul axe et s'effondre sur l'autre. Ton travail :
   a. Identifie dans "offre_dimensions" les 1 ou 2 dimensions réelles de cette
      offre (ex : ["growth marketing", "IA / automatisation"], ou une seule
      dimension si l'offre est vraiment mono-axe — ne force jamais une
      2e dimension qui n'existe pas dans l'offre).
   b. Pour CHAQUE angle (le défaut ET chaque angle proposé, sans exception),
      note-le dans "profils" sur CHAQUE dimension d'"offre_dimensions", de 0
      (hors sujet sur cette dimension) à 100 (parfait sur cette dimension).
      Tu ne réécris PAS les textes : le profil imprimé est le texte de l'angle
      retenu, repris tel quel du CV master.
   Le code choisira l'angle dont le PIRE des deux scores est le meilleur —
   pas celui qui a le score le plus haut sur un seul axe.
2. Dans chaque expérience, place en premier la réalisation la plus parlante
   pour cette offre.
3. N'intègre un mot-clé manquant que là où il décrit réellement le travail fait.
   Forcer un mot-clé là où il n'a pas sa place, c'est fabriquer du faux.
4. Verbe d'action en ouverture, pas de remplissage ("assurer le suivi de",
   "participer à").

OFFRES HYBRIDES — une offre qui combine deux dimensions (ex : marketing/
growth ET IA/tech) ne se réduit PAS à son intitulé de poste. Au-delà du choix
d'angle (point 1 ci-dessus, tranché par code), garde dans les compétences,
les bullets ET les catégories d'outils de quoi représenter LES DEUX
dimensions quand elles sont réellement présentes dans l'offre — y compris
les outils "métier" du côté non technique (plateformes publicitaires, CRM…)
si l'offre en parle. Une offre "AI Solutions Engineer, growth marketing" doit
ressortir du CV avec du growth ET de l'IA, jamais l'un réduit à une ligne au
profit de l'autre.

SÉLECTION ET MISE EN PAGE — le CV doit tenir sur une page A4 :
- competences : évalue toute la réserve pertinente avec un score chacune ;
  renvoie-en au moins 8 à 10 si la réserve le permet — le code garde les 8
  mieux notées, ne te charge pas toi-même de couper à 8.
- experiences : garde les expériences utiles à cette offre. Tu peux écarter
  une expérience marginale si elle n'apporte rien à cette candidature. L'ordre
  d'affichage est fixé par le code (chronologique inverse) : ne t'en occupe pas.
- bullets : 3 à 4 pour les deux expériences les plus importantes, 1 à 3 pour
  les autres — et un score par bullet, le code garde au maximum 4 par
  expérience en gardant les mieux notées si tu en soumets plus, et au moins
  2 quand la réserve le permet même si tu en soumets moins. Chaque bullet =
  15 à 25 mots, une seule idée, pas de parenthèse développée.
- outils : sélectionne UNIQUEMENT les catégories pertinentes pour cette
  offre (numéros dans la réserve). La catégorie "Bureautique" ne sort JAMAIS
  sauf si l'offre demande explicitement une maîtrise d'Office/Excel/
  PowerPoint/Google Workspace — dans le doute, ne la mets pas.
- projets : reprends par "id" ceux qui servent CETTE offre, avec un score de
  pertinence chacun ; le code les affiche dans l'ordre des scores. Tiens
  compte du type : un projet "conseil" se lit comme une mission (méthode,
  livrable, client), un projet "build" prouve la capacité à prototyper et à
  livrer seul. Liste CHAQUE projet de la réserve avec "retenu" : true s'il
  sert cette candidature, false sinon — false obligatoirement si son
  "contexte" le réserve à un autre type d'offre. Un projet non retenu n'est
  jamais imprimé, quel que soit son score. Un projet "conseil" (ex : un
  projet d'école) se sélectionne ICI, jamais dans "experiences".
  Pour un projet "conseil", choisis aussi dans "realisations" les numéros
  des réalisations à imprimer (2 ou 3), repris tels quels, en respectant
  son "contexte" (nombre maximum, lignes réservées à certaines offres).
- projets_position : "apres_experience" si l'offre valorise le fait de
  construire, prototyper, bricoler ses propres outils — les projets sont
  alors un argument central et se lisent juste après l'expérience
  professionnelle. "apres_formation" si l'offre attend d'abord un parcours
  professionnel et que les projets personnels ne sont qu'un complément.

Pour chaque bullet et chaque compétence, indique aussi un score de pertinence pour
CETTE offre précise, de 0 (hors sujet) à 100 (décisif pour ce poste). Le code trie
par ce score et coupe le surplus : sélectionne large dans la réserve, le score fait
le tri, ne présélectionne pas toi-même en n'en renvoyant que quelques-uns.

FORCE DE LA PREUVE — le score d'un bullet ne récompense pas qu'un mot-clé de
l'offre : il pèse la preuve derrière l'affirmation. Un résultat chiffré, un
client nommé ou un périmètre concret pèsent plus qu'une tâche générique. Note
en conséquence : un bullet d'automatisation personnelle ou de présentation
interne ne doit PAS surclasser un bullet avec résultat chiffré ou client
nommé juste parce qu'il matche mieux un mot-clé de l'offre — le code
renforce ce même arbitrage à la marge, mais ne peut pas rattraper un score
de départ qui inverse déjà l'ordre.

Réponds en JSON strict :
{
  "offre_dimensions": ["<dimension 1 de l'offre>", "<dimension 2, seulement si elle existe vraiment>"],
  "profils": [
    {
      "angle": "defaut",
      "scores_dimensions": [<score 0-100 sur la dimension 1>, <score 0-100 sur la dimension 2, si elle existe>]
    },
    {
      "angle": "<nom EXACT d'un angle proposé>",
      "scores_dimensions": [<idem>]
    }
  ],
  "experiences": [
    {
      "id": "<id de l'expérience>",
      "titre": "<uniquement si le titre n'est PAS verrouillé ; sinon omets ce champ>",
      "bullets": [
        {"source": <numéro de la réalisation d'origine>, "texte": "<formulation retenue>", "score": <0-100>}
      ]
    }
  ],
  "competences": [
    {"source": <numéro dans la réserve>, "texte": "<formulation retenue>", "score": <0-100>}
  ],
  "outils": [<numéros des catégories d'outils retenues>],
  "projets": [
    {"id": "<id du projet dans la réserve PROJETS>", "retenu": <true|false>, "score": <0-100>, "realisations": [<pour un projet "conseil" seulement : numéros des réalisations à imprimer, la plus parlante d'abord>]}
  ],
  "projets_position": "<apres_experience|apres_formation>",
  "changes_summary": ["<ce que tu as mis en avant et pourquoi>", "...", "..."]
}`;

    const raw = await streamClaude({ res, userPrompt, cachedPrefix, maxTokens: 12000 });
    const parsed = parseModelJson(res, raw);
    if (!parsed) return;

    const result = normalizeSelection(cv, parsed, { angle });
    logRewriteScores(result);
    sse(res, 'done', { result });
    res.end();
  } catch (err) {
    console.error('[rewrite]', err);
    sse(res, 'error', { message: friendlyError(err) });
    res.end();
  }
});

/* ------------------------------------------------------------------ *
 * Step 3 — Vérification factuelle
 * ------------------------------------------------------------------ */

app.post('/api/verify', async (req, res) => {
  const { rewrite } = req.body || {};
  openSse(res);

  try {
    if (!rewrite) {
      sse(res, 'error', { message: "L'étape 2 doit être terminée avant la vérification." });
      return res.end();
    }

    const cv = readMasterCv();

    sse(res, 'status', { message: 'Contrôle des chiffres et des noms propres…' });
    let violations = runFactChecks(cv, rewrite);

    sse(res, 'status', { message: 'Relecture de chaque ligne face à sa source…' });
    const semantic = await semanticFactCheck(changedPairs(rewrite, cv), callClaudeTool);
    const semanticAsViolations = semantic.map((s) => ({
      kind: 'affirmation',
      ref: s.ref,
      where: s.ref,
      detail: s.probleme,
    }));
    violations = violations.concat(semanticAsViolations);

    let verified = rewrite;
    let repaired = false;
    let remaining = violations;

    if (violations.length) {
      sse(res, 'status', {
        message: `${violations.length} ligne(s) à corriger — nouvelle passe…`,
      });
      verified = await repairViolations(cv, rewrite, violations, callClaudeTool);
      repaired = true;

      // Re-check both layers, not just the cheap one: the "rien d'inventé"
      // verdict is only worth anything if a semantic problem that survived
      // the repair still shows up here.
      sse(res, 'status', { message: 'Contre-vérification des lignes corrigées…' });
      const flaggedRefs = new Set(violations.map((v) => v.ref).filter(Boolean));
      const recheckPairs = changedPairs(verified, cv).filter((p) => flaggedRefs.has(p.ref));
      const stillOff = await semanticFactCheck(recheckPairs, callClaudeTool);

      remaining = runFactChecks(cv, verified).concat(
        stillOff.map((s) => ({ kind: 'affirmation', ref: s.ref, where: s.ref, detail: s.probleme }))
      );
    } else {
      remaining = [];
    }

    const g = verified._grounded || {};
    const changedCount = changedPairs(verified).length;
    const totalCount =
      (g.experiences || []).reduce((n, e) => n + (e.picked || []).length, 0) +
      (g.skills || []).length;

    // Pour chaque signalement non résolu : où il porte, la version « sûre »
    // (reprise verbatim de la source) et la version générée. L'interface
    // laisse l'utilisateur choisir.
    remaining = remaining.map((v) => ({ ...v, resolution: resolutionFor(cv, verified, v) }));

    sse(res, 'done', {
      result: {
        rewrite: verified,
        violations_found: violations,
        violations_remaining: remaining,
        repaired,
        stats: { total: totalCount, adapted: changedCount, verbatim: totalCount - changedCount },
        clean: remaining.length === 0,
      },
    });
    res.end();
  } catch (err) {
    console.error('[verify]', err);
    sse(res, 'error', { message: friendlyError(err) });
    res.end();
  }
});

/* ------------------------------------------------------------------ *
 * Step 4 — Score comparatif
 *
 * One call sees both the master CV and the tailored one against the same
 * offer, and scores them on the same rubric in the same breath. The old
 * pipeline scored them in two independent calls, which is why a rewrite
 * could come back "worse" than the original for no real reason.
 * ------------------------------------------------------------------ */

app.post('/api/score', async (req, res) => {
  const { rewrite, jobOffer } = req.body || {};
  openSse(res);

  try {
    if (!rewrite || !jobOffer) {
      sse(res, 'error', { message: "L'étape 3 doit être terminée avant le score." });
      return res.end();
    }

    const cv = readMasterCv();

    sse(res, 'status', { message: 'Comparaison avant / après face à l’offre…' });

    const userPrompt = `Tu reçois DEUX versions du CV d'un même candidat et UNE offre d'emploi.

Tu es le recruteur qui trie 200 CVs à 10 secondes pièce. Note les deux versions
sur la MÊME grille, dans la même lecture, pour que les deux notes soient
directement comparables. Une note ne récompense pas l'effort de réécriture :
elle estime la probabilité réelle d'un appel.

OFFRE :
${jobOffer}

VERSION A — CV master, non adapté :
${buildMasterCvText(cv)}

VERSION B — CV adapté à cette offre :
${rewrittenCvAsText(rewrite)}

Note chaque version sur 100 selon la même grille, puis explique l'écart.
Si la version B est moins bonne, dis-le franchement et dis pourquoi.

Réponds en JSON strict :
{
  "score_avant": <number 0-100>,
  "score_apres": <number 0-100>,
  "justification": "<2 à 3 phrases : ce qui explique l'écart entre les deux notes>",
  "gains": ["<ce que la version B fait mieux>", "..."],
  "restant": [
    {"fix": "<ce qui plafonne encore le score>", "why": "<pourquoi ça coûte un appel>"},
    {"fix": "...", "why": "..."}
  ],
  "ats_issues": ["<problème de parsing ATS, s'il y en a>"],
  "ready_to_generate": <true|false>
}`;

    const raw = await streamClaude({ res, userPrompt, maxTokens: 4000 });
    const parsed = parseModelJson(res, raw);
    if (!parsed) return;

    sse(res, 'done', { result: parsed });
    res.end();
  } catch (err) {
    console.error('[score]', err);
    sse(res, 'error', { message: friendlyError(err) });
    res.end();
  }
});

/* ------------------------------------------------------------------ *
 * Step 5 — HTML → PDF
 * ------------------------------------------------------------------ */

app.post('/api/generate-pdf', async (req, res) => {
  // jobOffer reaches this step too: the licence line, and the one-page
  // trimming below, are decided against the offer itself, not the analysis.
  const { lang, format, analysis, rewrite, websiteMode, jobOffer, scoreApres } = req.body || {};
  openSse(res);

  let browser;
  try {
    const cv = readMasterCv();

    let translated = null;
    const frPayload = lang === 'en' ? buildTranslationPayload(cv, { analysis, rewrite, websiteMode }) : null;
    if (lang === 'en') {
      sse(res, 'status', { message: 'Traduction en anglais…' });
      try {
        translated = await translateToEnglish(
          frPayload,
          callClaudeJson,
          TRANSLATE_SYSTEM_PROMPT
        );
      } catch (err) {
        console.error('[translate]', err);
        sse(res, 'status', { message: 'Traduction indisponible — le PDF sera généré en français.' });
      }
    }

    // Step 3 only ever saw the French rewrite, so nothing had checked the
    // English text that actually reaches the PDF. It is compared to the
    // French master — the source of truth — not to the rewrite it came from.
    if (translated) {
      sse(res, 'status', { message: 'Vérification de la traduction…' });
      const masterText = buildMasterCvText(cv);
      const items = translationItems(translated, frPayload);
      const problemes = await verifyTranslation({ masterText, items }, callClaudeTool);
      if (problemes.length) {
        problemes.forEach((p) => console.log(`  [translate:flag] ${p.ref} — ${p.probleme}`));
        const repaired = await repairTranslation({ masterText, items, problemes }, callClaudeTool);
        const { fixes, rejected } = rejectDuplicateFixes(items, repaired);
        rejected.forEach((r) =>
          console.log(`  [translate:rejected] ${r.ref} — réparation identique à ${r.duplicateOf}, traduction d'origine gardée`)
        );
        translated = applyTranslationFixes(translated, fixes);
        const unfixed = problemes.filter((p) => !fixes.has(p.ref));
        sse(res, 'status', {
          message: `Traduction : ${fixes.size}/${problemes.length} formulation(s) recadrée(s)${
            unfixed.length ? ` — ${unfixed.map((p) => p.ref).join(', ')} laissée(s) telle(s) quelle(s)` : ''
          }.`,
        });
      }
    }

    sse(res, 'status', { message: 'Construction du HTML…' });
    const renderHtml = (trim) =>
      buildCvHtml(cv, {
        format,
        analysis,
        rewrite,
        lang,
        translated,
        websiteMode,
        jobOffer,
        trim,
        templatePath: TEMPLATE_PATH,
      });

    sse(res, 'status', { message: 'Rendu de l’aperçu (Puppeteer)…' });
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    const page = await browser.newPage();
    // Match the print layout's dimensions so height measurements below are
    // taken against the same box size Puppeteer will actually paginate.
    await page.setViewport({ width: 794, height: 1123, deviceScaleFactor: 1 });
    await page.emulateMediaType('print');

    // Both variants go through this now: the ATS layout used to be left to
    // paginate on its own, which is exactly how a two-page "one-page CV"
    // got out. Content is trimmed by relevance first, type shrunk last.
    sse(res, 'status', { message: 'Ajustement pour tenir sur une page…' });
    // ATS text is smaller to begin with, so it gets a higher floor than the
    // design layout before "unreadable" beats "one page".
    const fit = await fitToOnePage(page, renderHtml, { minZoom: format === 'ats' ? 0.85 : 0.7 });
    const given = describeTrim(fit.trim);
    if (given) sse(res, 'status', { message: `Pour tenir sur une page : ${given}.` });
    if (fit.zoom < 1) {
      sse(res, 'status', {
        message: fit.fitted
          ? `Contenu réduit à ${Math.round(fit.zoom * 100)} % pour tenir sur une page.`
          : `Contenu trop long : réduit à ${Math.round(fit.zoom * 100)} %, le CV dépasse une page.`,
      });
    }

    // The PDF itself is deferred to /api/export-pdf: the person reviews and
    // edits this HTML first (contenteditable, in the browser), and only
    // their edited version ever gets written to disk.
    const html = await page.content();

    sse(res, 'done', {
      result: { html, fitted: fit.fitted, zoom: fit.zoom },
    });
    res.end();
  } catch (err) {
    console.error('[generate-pdf]', err);
    sse(res, 'error', { message: `Génération de l’aperçu impossible : ${err.message}` });
    res.end();
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
});

/**
 * Renders the PDF from the HTML the person actually reviewed and edited in
 * the browser — not from the master CV again. Manual edits made here skip
 * the fact-check layer entirely: the person owns whatever they typed.
 */
app.post('/api/export-pdf', async (req, res) => {
  const { html, lang, format, analysis, rewrite, websiteMode, jobOffer, scoreApres } = req.body || {};

  if (typeof html !== 'string' || !html.trim()) {
    res.status(400).json({ error: '"html" est requis (chaîne non vide).' });
    return;
  }

  let browser;
  try {
    const cv = readMasterCv();

    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 794, height: 1123, deviceScaleFactor: 1 });
    await page.emulateMediaType('print');
    await page.setContent(html, { waitUntil: 'load', timeout: 30000 });

    // The incoming HTML may already carry a --fit from the preview step.
    // Reset it before re-measuring so edits that shortened the CV can
    // reclaim the space, not just ones that lengthened it.
    await page.evaluate(() => {
      const p = document.querySelector('.page');
      if (p) p.style.setProperty('--fit', '1');
    });
    const fit = await fitOnePage(page, format === 'ats' ? 0.85 : 0.7);

    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '0', right: '0', bottom: '0', left: '0' },
    });

    // The DOM measurement above is a prediction; this is the artefact. A CV
    // that still runs long is reported rather than quietly downloaded.
    const pageCount = pdfPageCount(pdfBuffer);

    const filename = buildPdfFilename(cv, { analysis, format, lang });
    fs.writeFileSync(path.join(OUTPUTS_DIR, filename), pdfBuffer);

    // History is a convenience: a failure here must not cost the PDF that
    // was just rendered, so it is logged and swallowed.
    if (jobOffer && String(jobOffer).trim()) {
      try {
        await addGeneration({
          company: analysis && analysis.company_name,
          role: analysis && analysis.role_title,
          lang,
          format,
          websiteMode,
          jobOffer,
          analysis,
          rewrite,
          scoreApres,
          pdfFilename: filename,
          pdfUrl: `/outputs/${encodeURIComponent(filename)}`,
        });
      } catch (err) {
        console.error('[generations]', err);
      }
    }

    res.json({
      filename,
      url: `/outputs/${encodeURIComponent(filename)}`,
      pages: pageCount,
      fitted: fit.fitted,
    });
  } catch (err) {
    console.error('[export-pdf]', err);
    res.status(500).json({ error: `Export du PDF impossible : ${err.message}` });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
});

/* ------------------------------------------------------------------ *
 * Master CV read / update
 * ------------------------------------------------------------------ */

app.get('/api/master-cv', (req, res) => {
  try {
    // Lets the topbar show "mis à jour le …" from a plain HEAD request,
    // without that date living inside the editable JSON body itself.
    res.set('Last-Modified', fs.statSync(activeMasterCvPath()).mtime.toUTCString());
    // Raw, markers intact — the editor is where [FIXE] is added or removed.
    res.json(readMasterCvRaw());
  } catch (err) {
    res.status(500).json({ error: 'Impossible de lire master-cv.json.' });
  }
});

app.put('/api/master-cv', async (req, res) => {
  try {
    const payload = req.body && typeof req.body.content === 'string'
      ? JSON.parse(req.body.content)
      : req.body;

    await writeMasterCv(payload);
    res.json({ ok: true });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message || `JSON invalide.` });
  }
});

/* ------------------------------------------------------------------ *
 * Parse free text → master-cv.json structure
 * ------------------------------------------------------------------ */

const PARSE_CV_TOOL = {
  name: 'submit_cv',
  description: 'Soumet le CV structuré extrait du texte libre fourni.',
  input_schema: {
    type: 'object',
    properties: {
      personal: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          email: { type: 'string' },
          phone: { type: 'string' },
          location: { type: 'string', description: 'Ville, Région' },
          linkedin: { type: 'string', description: 'Sans https://www.' },
          website: { type: 'string', description: 'Chaîne vide si absent.' },
          github: { type: 'string', description: 'Chaîne vide si absent.' },
          disponibilite: { type: 'string' },
          age: { type: 'string', description: "Ex: '26 ans'. Chaîne vide si absent." },
          permis: { type: 'string', description: "Ex: 'Permis B'. Chaîne vide si absent." },
        },
        required: ['name', 'email', 'phone', 'location', 'linkedin', 'disponibilite'],
      },
      profil: { type: 'string', description: 'Paragraphe de présentation.' },
      experiences: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: "Slug court sans espace ni accent, ex: 'mon-entreprise'." },
            titre: { type: 'string' },
            entreprise: { type: 'string' },
            entreprise_url: { type: 'string', description: 'Chaîne vide si absent.' },
            type: { type: 'string', description: "Ex: 'Alternance', 'Stage', 'CDI'." },
            lieu: { type: 'string', description: 'Chaîne vide si absent.' },
            periode: { type: 'string', description: "Ex: 'Août 2024 — Août 2026'." },
            realisations: { type: 'array', items: { type: 'string' } },
          },
          required: ['id', 'titre', 'entreprise', 'type', 'periode', 'realisations'],
        },
      },
      education: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            diplome: { type: 'string' },
            ecole: { type: 'string' },
            periode: { type: 'string' },
            detail: { type: 'string', description: 'Chaîne vide si absent.' },
          },
          required: ['diplome', 'ecole', 'periode'],
        },
      },
      competences: { type: 'array', items: { type: 'string' } },
      outils: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string', description: 'Catégorie.' },
            valeur: { type: 'string', description: "Ex: 'outil1 · outil2 · outil3'." },
          },
          required: ['label', 'valeur'],
        },
      },
      langues: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            nom: { type: 'string' },
            niveau: { type: 'string', description: "Ex: 'Niveau — Description'." },
          },
          required: ['nom', 'niveau'],
        },
      },
      projets: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Identifiant court, slug (ex: "mon-projet").' },
            type: { type: 'string', enum: ['conseil', 'build'], description: '"build" par défaut, "conseil" si mission de conseil.' },
            nom: { type: 'string' },
            sous_titre: { type: 'string', description: 'Chaîne vide si absent.' },
            description: { type: 'string' },
          },
          required: ['id', 'type', 'nom', 'description'],
        },
      },
      interets: { type: 'array', items: { type: 'string' } },
    },
    required: [
      'personal',
      'profil',
      'experiences',
      'education',
      'competences',
      'outils',
      'langues',
      'projets',
      'interets',
    ],
  },
};

app.post('/api/parse-cv', async (req, res) => {
  const { text } = req.body || {};
  if (!text || !String(text).trim()) {
    return res.status(400).json({ error: 'Aucun texte fourni.' });
  }

  const userPrompt = `Tu reçois un CV en texte libre (peu importe le format, le style ou la langue).
Extrait toutes les informations et soumets-les via l'outil fourni.

Règles :
- Garde le texte en français si c'est déjà en français ; sinon traduis en français.
- Ne fabrique rien : si une information est absente, mets une chaîne vide.
- Ne soumets pas de champ "photo" (il est géré séparément).
- Génère un "id" court et unique pour chaque expérience (slug sans espace ni accent).

Texte du CV :
${text}`;

  try {
    const result = await callClaudeTool({
      system: "Tu es un expert en parsing de CV. Tu extrais les données d'un CV texte et les structures fidèlement.",
      userPrompt,
      tool: PARSE_CV_TOOL,
      maxTokens: 4000,
    });
    res.json({ ok: true, data: result });
  } catch (err) {
    console.error('[parse-cv]', err);
    res.status(500).json({ error: `Impossible de structurer le CV : ${err.message}` });
  }
});

/* ------------------------------------------------------------------ *
 * Application question answerer (Welcome to the Jungle, etc.)
 *
 * Short, concrete answers to the one-off custom questions job boards
 * ask during application ("pourquoi ce poste ?", "disponibilité ?"...).
 * Uses the master CV as ground truth and the same fluid, connector-led
 * tone as the cover letters — no punchy bullet-style fragments.
 * ------------------------------------------------------------------ */

app.post('/api/answer-question', async (req, res) => {
  const { question, jobOffer, lang } = req.body || {};
  if (!question || !String(question).trim()) {
    return res.status(400).json({ error: 'Aucune question fournie.' });
  }

  const cv = readMasterCv();
  const cvText = buildMasterCvText(cv);
  const language = lang === 'en' ? 'anglais' : 'français';
  const candidate = cv.personal.name;

  // The text is byte-identical to /api/analyze's cachedPrefix, but this
  // call's own system prompt and tool schema (answerTool) differ from
  // theirs — Anthropic hashes the full prefix, not just this block, so
  // this cannot read their cache entry. It creates its own, which is
  // still worth it: answering several form questions back to back in the
  // same session reuses it across those calls.
  const cachedPrefix = `Voici mon CV master :\n${cvText}`;

  const userPrompt = `Le CV master ci-dessus est la seule source de vérité — n'invente rien.

${jobOffer && String(jobOffer).trim() ? `OFFRE D'EMPLOI :\n${jobOffer}\n` : ''}
QUESTION DE CANDIDATURE (posée par le formulaire) :
${question}

Rédige une réponse courte et concrète à cette question, en ${language}, comme si ${candidate} la tapait lui-même dans un formulaire de candidature (type Welcome to the Jungle).

Règles :
- 2 à 4 phrases maximum, jamais plus.
- Phrases complètes et bien connectées, pas de tirets expressifs ("—") ni de ruptures de syntaxe façon bullet déguisé en prose. Utilise des connecteurs logiques ("ce qui", "notamment", "en particulier").
- Ton posé, professionnel mais humain — pas de punchline commerciale.
- Concret : appuie-toi sur de vraies informations du CV master, jamais d'invention.`;

  const answerTool = {
    name: 'submit_answer',
    description: "Soumet la réponse rédigée à la question de candidature.",
    input_schema: {
      type: 'object',
      properties: {
        answer: {
          type: 'string',
          description: 'La réponse rédigée, 2 à 4 phrases, en une seule chaîne de texte.',
        },
      },
      required: ['answer'],
    },
  };

  try {
    const result = await callClaudeTool({
      system: `Tu aides ${candidate} à répondre aux questions courtes des formulaires de candidature (Welcome to the Jungle et similaires).`,
      userPrompt,
      cachedPrefix,
      tool: answerTool,
      maxTokens: 500,
    });
    res.json({ ok: true, answer: result.answer });
  } catch (err) {
    console.error('[answer-question]', err);
    res.status(500).json({ error: `Impossible de générer une réponse : ${err.message}` });
  }
});

/* ------------------------------------------------------------------ *
 * Cover letter
 *
 * Same grounding rule as the CV — nothing that isn't in the master — and
 * the candidate's own register: full, connected sentences, explicit
 * connectors, no em-dash asides, no punchy fragments.
 * ------------------------------------------------------------------ */

app.post('/api/cover-letter', async (req, res) => {
  const { jobOffer, lang, notes } = req.body || {};
  if (!jobOffer || !String(jobOffer).trim()) {
    return res.status(400).json({ error: "Colle d'abord une offre d'emploi." });
  }

  const cv = readMasterCv();
  const language = lang === 'en' ? 'anglais' : 'français';
  const candidate = cv.personal.name;

  // Text is byte-identical to the other cachedPrefix uses, but this call's
  // own system prompt and tool schema (coverLetterTool) mean it can't share
  // a cache entry with any of them — same reasoning as /api/answer-question
  // above. It creates its own entry, reused only by a repeat cover-letter
  // call in the same session.
  const cachedPrefix = `Voici mon CV master :\n${buildMasterCvText(cv)}`;

  const userPrompt = `Le CV master ci-dessus est la seule source de faits — n'invente rien.

OFFRE D'EMPLOI :
${jobOffer}
${notes && String(notes).trim() ? `\nÀ FAIRE APPARAÎTRE (consigne du candidat) :\n${notes}\n` : ''}
Rédige une lettre de motivation en ${language} pour cette offre.

STYLE — impératif :
- Des phrases complètes et bien connectées, jamais de fragments ni de style
  télégraphique. Pas de bullet déguisé en prose.
- Aucun tiret cadratin ni tiret expressif ("—") : les idées s'enchaînent par
  des connecteurs logiques explicites ("ce qui", "notamment", "incluant",
  "ce qui me permet de", "en particulier").
- Ton posé, professionnel et humain. Ni punchline commerciale, ni superlatif.
- Termine par une formule d'ouverture simple du type "je serais ravi d'en
  discuter avec vous".

FOND :
- Environ 250 à 320 mots, quatre paragraphes courts.
- Accroche sur ce qui relie concrètement le candidat à CE poste, pas sur sa
  motivation en général.
- Deux ou trois faits précis tirés du CV master, choisis pour cette offre.
- Aucun chiffre, client, outil ou responsabilité qui ne soit pas dans le CV master.

`;

  const coverLetterTool = {
    name: 'submit_cover_letter',
    description: "Soumet l'objet et le corps de la lettre de motivation rédigée.",
    input_schema: {
      type: 'object',
      properties: {
        objet: { type: 'string', description: "Objet d'email court." },
        lettre: {
          type: 'string',
          description: 'Le corps de la lettre, paragraphes séparés par des sauts de ligne.',
        },
      },
      required: ['objet', 'lettre'],
    },
  };

  try {
    const result = await callClaudeTool({
      system:
        `Tu rédiges des lettres de motivation pour ${candidate}, dans son registre : phrases ` +
        'fluides et bien connectées, connecteurs logiques explicites, aucun tiret expressif, ton ' +
        'posé. Tu ne fabriques aucun fait.',
      userPrompt,
      cachedPrefix,
      tool: coverLetterTool,
      maxTokens: 1500,
    });
    res.json({ ok: true, objet: result.objet, lettre: result.lettre });
  } catch (err) {
    console.error('[cover-letter]', err);
    res.status(500).json({ error: `Impossible de générer la lettre : ${err.message}` });
  }
});

/* ------------------------------------------------------------------ *
 * Shorten — generic "Plus court" for the answer/letter tool outputs.
 * Not grounded against the master CV: it only condenses text that was
 * already generated (and already checked, in the letter/answer case),
 * so there's nothing new here for a fact-checker to verify.
 * ------------------------------------------------------------------ */

const SHORTEN_TOOL = {
  name: 'submit_shortened',
  description: 'Soumet la version raccourcie du texte.',
  input_schema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Le texte raccourci.' },
    },
    required: ['text'],
  },
};

app.post('/api/shorten', async (req, res) => {
  const { text } = req.body || {};
  if (!text || !String(text).trim()) {
    return res.status(400).json({ error: 'Aucun texte fourni.' });
  }

  const userPrompt = `Voici un texte :
${text}

Raccourcis-le d'environ un tiers, sans changer aucun fait, chiffre, nom propre ou outil. Garde le même ton et le même registre.`;

  try {
    const result = await callClaudeTool({
      system: "Tu raccourcis des textes sans en changer le sens ni le fond. Tu ne fabriques rien.",
      userPrompt,
      tool: SHORTEN_TOOL,
      maxTokens: 1000,
    });
    res.json({ ok: true, text: result.text });
  } catch (err) {
    console.error('[shorten]', err);
    res.status(500).json({ error: `Impossible de raccourcir : ${err.message}` });
  }
});

/* ------------------------------------------------------------------ *
 * PDF download
 * ------------------------------------------------------------------ */

app.get('/outputs/:filename', (req, res) => {
  const filename = path.basename(req.params.filename);
  if (!filename.toLowerCase().endsWith('.pdf')) {
    return res.status(400).send('Fichier non autorisé.');
  }
  const filePath = path.join(OUTPUTS_DIR, filename);
  if (!fs.existsSync(filePath)) return res.status(404).send('PDF introuvable.');
  res.download(filePath, filename);
});

/* ------------------------------------------------------------------ *
 * Dernières générations — l'offre est gardée avec ce qu'elle a produit,
 * ce qui permet de relancer une génération sans retrouver l'annonce.
 * ------------------------------------------------------------------ */

app.get('/api/generations', (req, res) => {
  try {
    res.json({ ok: true, generations: listGenerations() });
  } catch (err) {
    res.status(500).json({ error: 'Impossible de lire les dernières générations.' });
  }
});

app.get('/api/generations/:id', (req, res) => {
  try {
    const generation = getGeneration(req.params.id);
    if (!generation) return res.status(404).json({ error: 'Génération introuvable.' });
    res.json({ ok: true, generation });
  } catch (err) {
    res.status(500).json({ error: 'Impossible de lire cette génération.' });
  }
});

/* ------------------------------------------------------------------ *
 * Suivi des candidatures
 *
 * Recorded once, by hand, right after a CV download — "did you send
 * this?". No intermediate pipeline stages (interview, follow-up): just
 * whether it was sent, and — once known — whether it landed a call.
 * ------------------------------------------------------------------ */

app.get('/api/applications', (req, res) => {
  try {
    res.json({ ok: true, applications: readApplications() });
  } catch (err) {
    res.status(500).json({ error: 'Impossible de lire le suivi des candidatures.' });
  }
});

app.post('/api/applications', async (req, res) => {
  try {
    const { company, role, pdfFilename, pdfUrl, lang, scoreAvant, scoreApres, format, jobOffer } = req.body || {};
    const application = await addApplication({ company, role, pdfFilename, pdfUrl, lang, scoreAvant, scoreApres, format, jobOffer });
    res.json({ ok: true, application });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Impossible d’enregistrer la candidature.' });
  }
});

app.patch('/api/applications/:id', async (req, res) => {
  try {
    const { status, interviewDate } = req.body || {};
    const application = await updateApplication(req.params.id, { status, interviewDate });
    res.json({ ok: true, application });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Impossible de mettre à jour la candidature.' });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(ROOT, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n  CV Optimizer → http://localhost:${PORT}`);
  console.log(`  Modèle : ${MODEL}`);
  if (activeMasterCvPath() !== MASTER_CV_PATH) {
    console.log('  master-cv.json absent — CV d’exemple fictif chargé (master-cv.example.json).');
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('  ⚠️  ANTHROPIC_API_KEY absente — ajoute-la dans .env avant de générer.\n');
  } else {
    console.log('');
  }
});
