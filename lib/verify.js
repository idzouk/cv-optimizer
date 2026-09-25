'use strict';

/* ------------------------------------------------------------------ *
 * Step 3 — Vérification factuelle
 *
 * The trust layer. Step 2 promised every line traces back to a numbered
 * master entry; here we actually check it, mechanically, before anything
 * reaches a PDF:
 *
 *  - every figure in a line must already appear in the line it came from;
 *  - every proper noun must exist somewhere in the master CV;
 *  - a second model pass reads each changed line against its source and
 *    reports anything the source does not support.
 *
 * Anything flagged goes back to the model once for repair. Whatever is
 * still flagged after that is shown to the user rather than hidden — the
 * point is that nothing false reaches the PDF silently.
 * ------------------------------------------------------------------ */

/** Figures in a string, normalised ("50 000" and "50000" compare equal). */
const NUMBER_RE = /\d+(?:[\s  ]\d{3})*(?:[.,]\d+)?/g;

function extractNumbers(text) {
  return new Set(
    (String(text || '').match(NUMBER_RE) || []).map((n) =>
      n.replace(/[\s  .]/g, '').replace(',', '.')
    )
  );
}

/** Capitalised tokens, skipping the ones that merely open a sentence. */
const PROPER_RE = /[A-ZÀ-Ý][\wÀ-ÿ.&+-]*/gu;

function extractProperNouns(text) {
  const s = String(text || '');
  const found = new Set();
  let m;
  PROPER_RE.lastIndex = 0;
  while ((m = PROPER_RE.exec(s)) !== null) {
    const before = s.slice(0, m.index).trimEnd();
    const opensSentence = before === '' || /[.:;!?•\-–—]$/.test(before);
    if (!opensSentence && m[0].length > 1) found.add(m[0]);
  }
  return found;
}

/**
 * The master CV minus the base64 photo. Walking that blob would flood the
 * allow-lists with fragments of encoded image data — every check downstream
 * would then wave through nonsense that happens to appear in it.
 */
function cvProse(cv) {
  const { personal, ...rest } = cv;
  const { photo, ...personalRest } = personal || {};
  return { personal: personalRest, ...rest };
}

/** Every proper noun that legitimately exists anywhere in the master CV. */
function masterProperNouns(cv) {
  const bag = new Set();
  const walk = (node) => {
    if (typeof node === 'string') {
      extractProperNouns(node).forEach((w) => bag.add(w));
      // Sentence-openers count as legitimate vocabulary too.
      (node.match(PROPER_RE) || []).forEach((w) => bag.add(w));
    } else if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === 'object') Object.values(node).forEach(walk);
  };
  walk(cvProse(cv));
  return bag;
}

/** Every figure that appears anywhere in the master CV. */
function masterNumbers(cv) {
  const bag = new Set();
  const walk = (node) => {
    if (typeof node === 'string') extractNumbers(node).forEach((n) => bag.add(n));
    else if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === 'object') Object.values(node).forEach(walk);
  };
  walk(cvProse(cv));
  return bag;
}

/**
 * Deterministic checks over every line the model adapted. Lines it kept
 * verbatim cannot drift, so they are skipped.
 */
function runFactChecks(cv, rewrite) {
  const violations = [];
  const allowedNouns = masterProperNouns(cv);
  const g = rewrite._grounded || {};

  const checkPair = (where, finalText, sourceText) => {
    const srcNumbers = extractNumbers(sourceText);
    for (const n of extractNumbers(finalText)) {
      if (!srcNumbers.has(n)) {
        violations.push({
          kind: 'chiffre',
          where,
          detail: `le chiffre « ${n} » n'apparaît pas dans la réalisation d'origine`,
          sourceText,
          finalText,
        });
      }
    }
    for (const w of extractProperNouns(finalText)) {
      if (!allowedNouns.has(w)) {
        violations.push({
          kind: 'nom propre',
          where,
          detail: `« ${w} » n'apparaît nulle part dans le CV master`,
          sourceText,
          finalText,
        });
      }
    }
  };

  (g.experiences || []).forEach((exp) => {
    (exp.picked || []).forEach((p, i) => {
      if (p.changed) checkPair(`${exp.id} · bullet ${i + 1}`, p.text, p.sourceText);
    });
  });
  (g.skills || []).forEach((s, i) => {
    if (s.changed) checkPair(`compétence ${i + 1}`, s.text, s.sourceText);
  });

  // The profile is now ONE chosen angle, reused near-verbatim — checked
  // against that angle's own text, not the whole master, and not through
  // checkPair (whose proper-noun half is deliberately master-wide, to allow
  // e.g. a bullet reusing a name from a sibling bullet of the same
  // experience). Master-wide would silently accept a figure or proper noun
  // pulled in from a DIFFERENT angle — exactly the fusion this control
  // exists to catch — so both halves are scoped to this one angle's text.
  const profile = rewrite.summary_rewritten || '';
  const profileSource = profileSourceText(cv, g.profil_angle);
  if (profile.trim() && profile.trim() !== String(profileSource || '').trim()) {
    const sourceNumbers = extractNumbers(profileSource);
    const sourceNouns = extractProperNouns(profileSource);
    for (const n of extractNumbers(profile)) {
      if (!sourceNumbers.has(n)) {
        violations.push({
          kind: 'chiffre',
          where: 'profil',
          ref: 'profil',
          detail: `le chiffre « ${n} » n'apparaît pas dans l'angle de profil choisi`,
          sourceText: profileSource,
          finalText: profile,
        });
      }
    }
    for (const w of extractProperNouns(profile)) {
      if (!sourceNouns.has(w)) {
        violations.push({
          kind: 'nom propre',
          where: 'profil',
          ref: 'profil',
          detail: `« ${w} » n'apparaît pas dans l'angle de profil choisi (fusion avec un autre angle ?)`,
          sourceText: profileSource,
          finalText: profile,
        });
      }
    }
  }

  return violations;
}

/**
 * A synonym may restate WHAT a job involved; it may never move the candidate
 * up a hierarchy, a scope or a seniority scale. That distinction is the one
 * an HR reader catches instantly ("direction" read back as "C-suite"), so it
 * is spelled out rather than left to the model's judgement — both for the
 * French rewrite and for the English translation.
 */
const ANTI_SURCLASSEMENT_RULE = `Contrôle anti-surclassement — un synonyme est acceptable
pour le CONTENU d'un métier, jamais pour un niveau hiérarchique, un périmètre ou une
séniorité. Signale toute montée d'un cran, même implicite :
- interlocuteurs : "direction", "décideurs marketing", "responsables" ne deviennent pas
  "C-suite", "executive committee", "board", "senior leadership" ni "executives" ;
- relation : "direct" (interlocuteur direct, contact direct) ne devient jamais
  "primary", "lead" ni "main" — direct décrit l'absence d'intermédiaire, pas un rang ;
- rôle : "consultant", "chargé de", "assistant" ne deviennent pas "lead", "head of",
  "manager", "director" ; "co-fondateur" ne devient pas "CEO" ;
- périmètre : un nombre de comptes, de pays, de personnes ou de marques ne s'arrondit
  pas vers le haut, et un périmètre d'équipe ne devient pas un périmètre d'entreprise ;
- contribution : "participation à", "contribution", "support" ne deviennent pas
  "pilotage", "ownership", "led" ni "drove".`;

/**
 * The one paragraph a tailored profile may draw on: the default profile, or
 * — when the rewrite picked a named angle — that angle's own text and
 * nothing else. Picking one angle and reusing it near-verbatim (vocabulary
 * only) is the rule now; a profile is never a fresh synthesis across angles.
 */
function profileSourceText(cv, angle) {
  if (angle && angle !== 'defaut') {
    const variant = (cv.profil_variants || []).find((v) => v.angle === angle);
    if (variant) return variant.texte || '';
  }
  return cv.profil || '';
}

/** The changed lines, paired with their source — input to the semantic pass. */
function changedPairs(rewrite, cv) {
  const g = rewrite._grounded || {};
  const pairs = [];
  (g.experiences || []).forEach((exp) => {
    (exp.picked || []).forEach((p, i) => {
      if (p.changed) {
        pairs.push({ ref: `exp:${exp.id}:${i}`, source: p.sourceText, final: p.text });
      }
    });
  });
  (g.skills || []).forEach((s, i) => {
    if (s.changed) pairs.push({ ref: `skill:${i}`, source: s.sourceText, final: s.text });
  });
  if (cv && rewrite.summary_rewritten) {
    const source = profileSourceText(cv, g.profil_angle);
    if (rewrite.summary_rewritten.trim() !== String(source || '').trim()) {
      pairs.push({ ref: 'profil', source, final: rewrite.summary_rewritten });
    }
  }
  return pairs;
}

const FACT_CHECK_TOOL = {
  name: 'submit_fact_check',
  description: 'Soumet la liste des reformulations qui affirment plus que leur source.',
  input_schema: {
    type: 'object',
    properties: {
      problemes: {
        type: 'array',
        description: "Une entrée par reformulation qui pose problème. Liste vide si aucune n'en pose.",
        items: {
          type: 'object',
          properties: {
            ref: { type: 'string', description: 'La "ref" de la paire concernée, reprise telle quelle.' },
            probleme: { type: 'string', description: 'Ce qui est affirmé en trop, en une phrase.' },
          },
          required: ['ref', 'probleme'],
        },
      },
    },
    required: ['problemes'],
  },
};

/** Asks the model to flag any adapted line that claims more than its source. */
async function semanticFactCheck(pairs, callClaudeTool) {
  if (!pairs.length) return [];

  const userPrompt = `Tu vérifies un CV avant envoi. Pour chaque paire ci-dessous, la
ligne "source" contient des faits vrais du candidat, la ligne "finale" en est une
reformulation destinée à une offre précise.

Signale UNIQUEMENT les reformulations qui affirment quelque chose que la source
n'affirme pas : un fait ajouté, une responsabilité élargie, un résultat suggéré,
une montée en grade implicite, un outil ou un client qui n'était pas là.

Une reformulation plus courte, plus directe, ou qui emploie un synonyme du métier
n'est PAS un problème tant que le niveau hiérarchique, le périmètre et les faits
restent exactement ceux de la source. Ne signale pas les changements de style.

${ANTI_SURCLASSEMENT_RULE}

Paires :
${JSON.stringify(pairs, null, 2)}`;

  try {
    const out = await callClaudeTool({
      system:
        "Tu es un vérificateur factuel rigoureux et neutre. Tu compares une reformulation à sa source " +
        "et tu ne signales que les ajouts de fond.",
      userPrompt,
      tool: FACT_CHECK_TOOL,
      maxTokens: 2000,
    });
    return (out && out.problemes) || [];
  } catch (err) {
    console.error('[verify:semantic]', err);
    return [];
  }
}

const REPAIR_TOOL = {
  name: 'submit_corrections',
  description: 'Soumet les formulations corrigées, strictement fidèles à leur source.',
  input_schema: {
    type: 'object',
    properties: {
      corrections: {
        type: 'array',
        description: 'Une entrée par élément à corriger, une seule par "ref".',
        items: {
          type: 'object',
          properties: {
            ref: { type: 'string', description: 'La "ref" de l\'élément corrigé, reprise telle quelle.' },
            texte: { type: 'string', description: 'La formulation corrigée.' },
          },
          required: ['ref', 'texte'],
        },
      },
    },
    required: ['corrections'],
  },
};

/** Re-runs the flagged lines through the model, asking for grounded fixes. */
async function repairViolations(cv, rewrite, violations, callClaudeTool) {
  const g = rewrite._grounded || {};

  const items = [];
  (g.experiences || []).forEach((exp) => {
    (exp.picked || []).forEach((p, i) => {
      const ref = `exp:${exp.id}:${i}`;
      if (violations.some((v) => v.ref === ref || v.where === `${exp.id} · bullet ${i + 1}`)) {
        items.push({ ref, source: p.sourceText, actuel: p.text });
      }
    });
  });
  (g.skills || []).forEach((s, i) => {
    const ref = `skill:${i}`;
    if (violations.some((v) => v.ref === ref || v.where === `compétence ${i + 1}`)) {
      items.push({ ref, source: s.sourceText, actuel: s.text });
    }
  });
  if (violations.some((v) => v.ref === 'profil' || v.where === 'profil')) {
    items.push({
      ref: 'profil',
      source: profileSourceText(cv, g.profil_angle),
      actuel: rewrite.summary_rewritten || '',
    });
  }
  if (!items.length) return rewrite;

  const userPrompt = `Ces reformulations ont été rejetées : elles affirment des choses que leur
source n'affirme pas.

Réécris chacune en restant stricement dans ce que dit sa source. Tu peux raccourcir,
choisir un autre angle, employer le vocabulaire du métier — mais tu n'ajoutes aucun
fait, chiffre, outil, client ni résultat absent de la source. En cas de doute, reprends
la source telle quelle.

Éléments à corriger :
${JSON.stringify(items, null, 2)}

Problèmes relevés :
${violations.map((v) => `- ${v.where || v.ref} : ${v.detail || v.probleme}`).join('\n')}`;

  let corrections = [];
  try {
    const out = await callClaudeTool({
      system: "Tu corriges des lignes de CV pour qu'elles n'affirment rien de plus que leur source.",
      userPrompt,
      tool: REPAIR_TOOL,
      maxTokens: 2000,
    });
    corrections = (out && out.corrections) || [];
  } catch (err) {
    console.error('[verify:repair]', err);
    return rewrite;
  }

  const byRef = new Map(corrections.map((c) => [c.ref, String(c.texte || '').trim()]));
  const next = JSON.parse(JSON.stringify(rewrite));

  (next._grounded.experiences || []).forEach((exp) => {
    (exp.picked || []).forEach((p, i) => {
      const fix = byRef.get(`exp:${exp.id}:${i}`);
      if (fix) {
        p.text = fix;
        p.changed = fix !== p.sourceText;
        p.repaired = true;
      }
    });
  });
  (next._grounded.skills || []).forEach((s, i) => {
    const fix = byRef.get(`skill:${i}`);
    if (fix) {
      s.text = fix;
      s.changed = fix !== s.sourceText;
      s.repaired = true;
    }
  });

  const profileFix = byRef.get('profil');
  if (profileFix) next.summary_rewritten = profileFix;

  // Mirror the repaired text back into the flat shape the renderer uses.
  const expTextById = new Map(
    next._grounded.experiences.map((e) => [e.id, e.picked.map((p) => p.text)])
  );
  (next.experiences_rewritten || []).forEach((e) => {
    const texts = expTextById.get(e.id);
    if (texts) e.bullets = texts;
  });
  next.skills_rewritten = next._grounded.skills.map((s) => s.text);

  return next;
}

const TRANSLATION_CHECK_TOOL = {
  name: 'submit_translation_check',
  description: "Soumet la liste des lignes anglaises qui affirment plus que le CV master français.",
  input_schema: {
    type: 'object',
    properties: {
      problemes: {
        type: 'array',
        description: "Une entrée par ligne anglaise qui pose problème. Liste vide si aucune n'en pose.",
        items: {
          type: 'object',
          properties: {
            ref: { type: 'string', description: 'La "ref" de la ligne concernée, reprise telle quelle.' },
            probleme: { type: 'string', description: 'Ce qui est affirmé en trop, en une phrase.' },
          },
          required: ['ref', 'probleme'],
        },
      },
    },
    required: ['problemes'],
  },
};

const TRANSLATION_CHECK_INTRO = `Tu vérifies la version ANGLAISE d'un CV avant envoi.

La référence est le CV MASTER EN FRANÇAIS fourni plus haut : c'est la seule source de
vérité. Chaque ligne anglaise vient d'une adaptation à une offre, puis d'une traduction —
tu la compares donc directement au master français, jamais à une version intermédiaire.

Signale UNIQUEMENT une ligne anglaise qui affirme quelque chose que le master français
n'affirme pas : fait ajouté, chiffre absent ou différent, responsabilité élargie, client
ou outil qui n'y figure pas, montée en grade.

Une traduction plus courte, plus idiomatique, ou qui emploie le vocabulaire anglais usuel
du métier n'est PAS un problème, tant que le niveau, le périmètre et les faits restent
ceux du master.

Chaque ligne porte, dans "fr", la ligne du CV français dont elle est la traduction. Elle
sert UNIQUEMENT à savoir de quelle ligne il s'agit : elle ne rend rien acceptable. Les faits,
le niveau et le périmètre de "en" se jugent toujours mot à mot contre le master, avec le
contrôle anti-surclassement ci-dessous. La "ref" (ex : "skill:1") est une position dans ce
CV, jamais un numéro de la réserve du master : un ordre ou une numérotation différente de
celle du master n'est JAMAIS un problème, ne le signale pas.`;

const TRANSLATION_PROFILE_RULE = `Cas particulier — la ligne "profile" est une synthèse de
l'ensemble du CV : relier des éléments qui figurent à des endroits différents du master est
le travail attendu. Ne la signale que si elle avance un fait introuvable dans tout le master.`;

/**
 * Checks the translated English CV against the FRENCH MASTER rather than
 * against the French rewrite it was translated from: a wording that already
 * drifted during the rewrite would otherwise be validated against an
 * already-drifted reference. This is the only check that ever reads the
 * English text — without it, step 3's guarantees stop at the translation.
 */
/**
 * The interlocutor terms ANTI_SURCLASSEMENT_RULE forbids, checked by code
 * as well: the model check alone let "(marketing, executive)" through for
 * "(marketing, direction)" on one Dust run after flagging it on two others.
 * A term is only flagged when the master has no French equivalent of it.
 */
const OVERCLAIM_TERMS = [
  { en: /\bc-suite\b/i, fr: /c-suite|comex|comité exécutif/i },
  { en: /\bexecutives?\b/i, fr: /\bexécuti(?:fs?|ves?)\b|comex/i },
  { en: /\bboard\b/i, fr: /conseil d'administration|\bboard\b/i },
  { en: /\bsenior leadership\b/i, fr: /direction générale|comex|comité exécutif/i },
  { en: /\bCEO\b/, fr: /\bCEO\b|\bPDG\b|directeur général/i },
];

/** "direct" in the French line read back as a rank: "interlocuteur
 *  direct" → "primary point of contact" (Dust run, 2026-09-24). */
const DIRECT_FR = /\bdirect(?:e|s|es)?\b/i;
const DIRECT_EN = /\bdirect(?:ly)?\b/i;
const RANK_EN = /\b(?:primary|lead|main)\b/i;

function overclaimTranslationFlags(items, masterText) {
  const master = String(masterText || '');
  return (items || []).flatMap((it) => {
    const hit = OVERCLAIM_TERMS.find((t) => t.en.test(it.en) && !t.fr.test(master));
    if (hit) {
      const word = it.en.match(hit.en)[0];
      return [{ ref: it.ref, probleme: `"${word}" surclasse le niveau des interlocuteurs : le master ne dit rien d'équivalent.` }];
    }
    if (it.fr && DIRECT_FR.test(it.fr) && !DIRECT_EN.test(it.en) && RANK_EN.test(it.en)) {
      const word = it.en.match(RANK_EN)[0];
      return [{ ref: it.ref, probleme: `"direct" est devenu "${word}" : direct décrit l'absence d'intermédiaire, pas un rang — garder "direct".` }];
    }
    return [];
  });
}

async function verifyTranslation({ masterText, items }, callClaudeTool) {
  if (!items || !items.length) return [];
  const coded = overclaimTranslationFlags(items, masterText);
  const merge = (fromModel) => {
    const refs = new Set(coded.map((p) => p.ref));
    return [...coded, ...fromModel.filter((p) => p && !refs.has(p.ref))];
  };

  const userPrompt = `${TRANSLATION_CHECK_INTRO}

${ANTI_SURCLASSEMENT_RULE}

${TRANSLATION_PROFILE_RULE}

Lignes anglaises à vérifier :
${JSON.stringify(items, null, 2)}`;

  try {
    const out = await callClaudeTool({
      system:
        "Tu es un vérificateur factuel rigoureux et neutre. Tu compares une version anglaise " +
        "à son CV master français et tu ne signales que les ajouts de fond et les surclassements.",
      userPrompt,
      cachedPrefix: `Voici mon CV master :\n${masterText}`,
      tool: TRANSLATION_CHECK_TOOL,
      maxTokens: 2000,
    });
    return merge((out && out.problemes) || []);
  } catch (err) {
    console.error('[verify:translation]', err);
    return coded;
  }
}

const TRANSLATION_REPAIR_TOOL = {
  name: 'submit_translation_corrections',
  description: "Soumet les formulations anglaises corrigées, strictement fidèles au master français.",
  input_schema: {
    type: 'object',
    properties: {
      corrections: {
        type: 'array',
        description: 'Une entrée par ligne à corriger, une seule par "ref".',
        items: {
          type: 'object',
          properties: {
            ref: { type: 'string', description: 'La "ref" de la ligne corrigée, reprise telle quelle.' },
            texte: { type: 'string', description: 'La formulation anglaise corrigée.' },
          },
          required: ['ref', 'texte'],
        },
      },
    },
    required: ['corrections'],
  },
};

/**
 * Rewrites the flagged English lines against the French master. Returns a
 * Map<ref, texte> — the caller decides where each ref lives in the payload.
 */
async function repairTranslation({ masterText, items, problemes }, callClaudeTool) {
  const flagged = new Set((problemes || []).map((p) => p.ref));
  const toFix = (items || []).filter((it) => flagged.has(it.ref));
  if (!toFix.length) return new Map();

  const userPrompt = `Ces lignes de la version ANGLAISE d'un CV ont été rejetées : elles affirment
des choses que le CV master français fourni plus haut n'affirme pas.

Réécris chacune en anglais professionnel, en restant strictement dans ce que dit le master.
Chaque ligne porte, dans "fr", sa ligne française source : ta correction traduit CETTE ligne,
jamais une autre ligne du master, et ne recopie jamais une autre ligne du CV.
Tu peux raccourcir ou changer d'angle, mais tu n'ajoutes aucun fait, chiffre, outil, client
ni résultat absent du master, et tu ne montes jamais d'un cran le niveau hiérarchique, le
périmètre ou la séniorité. En cas de doute, traduis le master au plus près.

${ANTI_SURCLASSEMENT_RULE}

Lignes à corriger :
${JSON.stringify(toFix, null, 2)}

Problèmes relevés :
${(problemes || []).map((p) => `- ${p.ref} : ${p.probleme}`).join('\n')}`;

  try {
    const out = await callClaudeTool({
      system: "Tu corriges des lignes de CV en anglais pour qu'elles n'affirment rien de plus que le CV master français.",
      userPrompt,
      cachedPrefix: `Voici mon CV master :\n${masterText}`,
      tool: TRANSLATION_REPAIR_TOOL,
      maxTokens: 2000,
    });
    const corrections = (out && out.corrections) || [];
    return new Map(
      corrections
        .map((c) => [c.ref, String(c.texte || '').trim()])
        .filter(([, texte]) => texte)
    );
  } catch (err) {
    console.error('[verify:translation-repair]', err);
    return new Map();
  }
}

/**
 * Localise un signalement (profil / bullet d'expérience / compétence) et
 * renvoie de quoi l'interface propose un choix : le champ visé, la version
 * sûre (source verbatim, ou profil master) et la version générée signalée.
 */
function resolutionFor(cv, verified, v) {
  const g = verified._grounded || {};

  if (v.ref === 'profil' || v.where === 'profil') {
    return {
      field: 'profil',
      label: 'profil',
      safeText: profileSourceText(cv, g.profil_angle),
      flaggedText: verified.summary_rewritten || '',
    };
  }

  let m = String(v.ref || '').match(/^exp:(.+):(\d+)$/);
  if (!m) {
    const w = String(v.where || '').match(/^(.+?) · bullet (\d+)$/u);
    if (w) m = [null, w[1], String(Number(w[2]) - 1)];
  }
  if (m) {
    const exp = (g.experiences || []).find((e) => e.id === m[1]);
    const p = exp && exp.picked && exp.picked[Number(m[2])];
    if (p) {
      return {
        field: `exp:${m[1]}:${m[2]}`,
        label: `${m[1]} · réalisation ${Number(m[2]) + 1}`,
        safeText: p.sourceText || '',
        flaggedText: p.text || '',
      };
    }
  }

  let s = String(v.ref || '').match(/^skill:(\d+)$/);
  if (!s) {
    const w = String(v.where || '').match(/^compétence (\d+)$/u);
    if (w) s = [null, String(Number(w[1]) - 1)];
  }
  if (s) {
    const sk = (g.skills || [])[Number(s[1])];
    if (sk) {
      return {
        field: `skill:${s[1]}`,
        label: `compétence ${Number(s[1]) + 1}`,
        safeText: sk.sourceText || '',
        flaggedText: sk.text || '',
      };
    }
  }

  return null;
}

module.exports = {
  ANTI_SURCLASSEMENT_RULE,
  extractNumbers,
  extractProperNouns,
  cvProse,
  masterProperNouns,
  masterNumbers,
  runFactChecks,
  profileSourceText,
  changedPairs,
  semanticFactCheck,
  repairViolations,
  overclaimTranslationFlags,
  verifyTranslation,
  repairTranslation,
  resolutionFor,
};
