/* CV Optimizer — front-end orchestration (vanilla JS, no framework). */
'use strict';

/* ------------------------------------------------------------------ *
 * Small DOM helpers
 * ------------------------------------------------------------------ */

const $ = (sel) => document.querySelector(sel);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */

const state = {
  lang: 'fr',
  mode: 'auto',
  format: 'design',
  websiteMode: 'none',
  // 'auto' lets step 2 pick by score; any other value is a master angle
  // ("defaut" or a profil_variants angle) printed as-is.
  angle: 'auto',
  analysis: null,
  rewrite: null,
  verify: null,
  score: null,
  previewHtml: null,
  pdf: null,
  running: false,
};

const STEPS = [
  { id: 1, title: "Analyse de l'offre", endpoint: '/api/analyze' },
  { id: 2, title: 'Sélection groundée', endpoint: '/api/rewrite' },
  { id: 3, title: 'Vérification factuelle', endpoint: '/api/verify' },
  { id: 4, title: 'Score avant / après', endpoint: '/api/score' },
  { id: 5, title: 'Aperçu du CV', endpoint: '/api/generate-pdf' },
];

/* ------------------------------------------------------------------ *
 * Chip menu — the settings-as-a-sentence dropdowns
 * ------------------------------------------------------------------ */

let _openChipMenu = null;

function closeChipMenu() {
  if (!_openChipMenu) return;
  _openChipMenu.menu.remove();
  _openChipMenu.btn.setAttribute('aria-expanded', 'false');
  _openChipMenu = null;
}

document.addEventListener('click', closeChipMenu);
window.addEventListener('scroll', closeChipMenu, true);

/**
 * Turns a chip button into a dropdown: options is [{value, label}], onChange
 * fires with the picked value. The chip's own text (minus its chevron svg)
 * is kept in sync with the current selection.
 */
function createChip(id, options, onChange) {
  const btn = $(`#${id}`);
  const svg = btn.querySelector('svg');

  function setValue(value) {
    const opt = options.find((o) => o.value === value) || options[0];
    btn.textContent = '';
    btn.append(document.createTextNode(opt.label));
    if (svg) btn.append(svg);
    btn.dataset.value = opt.value;
  }

  btn.addEventListener('click', (event) => {
    event.stopPropagation();
    if (_openChipMenu && _openChipMenu.btn === btn) {
      closeChipMenu();
      return;
    }
    closeChipMenu();

    const menu = el('div', 'chip-menu');
    options.forEach((o) => {
      const item = el(
        'button',
        'chip-menu-option' + (o.value === btn.dataset.value ? ' is-selected' : ''),
        o.label
      );
      item.type = 'button';
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        setValue(o.value);
        closeChipMenu();
        onChange(o.value);
      });
      menu.append(item);
    });

    document.body.append(menu);
    const r = btn.getBoundingClientRect();
    menu.style.left = `${Math.round(r.left)}px`;
    menu.style.top = `${Math.round(r.bottom + 8)}px`;
    btn.setAttribute('aria-expanded', 'true');
    _openChipMenu = { btn, menu };
  });

  setValue(btn.dataset.value);
  return { setValue };
}

/* ------------------------------------------------------------------ *
 * Step rail
 * ------------------------------------------------------------------ */

const GLYPHS = {
  pending: '<div class="glyph-wait"></div>',
  running:
    '<div class="glyph-run"><div class="glyph-run-dot"></div></div>',
  done:
    '<div class="glyph-done"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#FAFAF7" stroke-width="3"><path d="M5 12l5 5 9-10"></path></svg></div>',
  error:
    '<div class="glyph-error"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#FAFAF7" stroke-width="3"><path d="M6 6l12 12M18 6L6 18"></path></svg></div>',
};

const cards = new Map();

function buildSteps() {
  const container = $('#steps');
  container.innerHTML = '';
  cards.clear();
  $('#steps-card').classList.add('is-idle');
  $('#steps-head-title').textContent = 'Pipeline';

  for (const step of STEPS) {
    const row = el('div', 'step is-pending');
    row.id = `step-${step.id}`;

    const glyph = el('div', 'step-glyph');
    glyph.innerHTML = GLYPHS.pending;

    const wrap = el('div');
    const head = el('button', 'step-head');
    head.type = 'button';
    const ttl = el('div', 'step-ttl');
    const title = el('span', 'step-title', step.title);
    const stateEl = el('span', 'step-state', '');
    ttl.append(title, stateEl);
    const timeEl = el('span', 'step-time', '');
    head.append(ttl, timeEl);
    const body = el('div', 'step-body');
    head.addEventListener('click', () => row.classList.toggle('is-open'));
    wrap.append(head, body);

    row.append(glyph, wrap);
    container.append(row);
    cards.set(step.id, { row, glyph, title, stateEl, timeEl, body, startedAt: null });
  }
}

function setStepState(id, status, label) {
  const c = cards.get(id);
  if (!c) return;
  $('#steps-card').classList.remove('is-idle');
  c.row.classList.remove('is-pending', 'is-running', 'is-done', 'is-error');
  c.row.classList.add(`is-${status}`);
  c.glyph.innerHTML = GLYPHS[status] || GLYPHS.pending;
  c.stateEl.textContent = label || '';

  if (status === 'running') {
    c.startedAt = performance.now();
    c.timeEl.textContent = '';
  } else if ((status === 'done' || status === 'error') && c.startedAt) {
    const secs = (performance.now() - c.startedAt) / 1000;
    c.timeEl.textContent = `${secs.toFixed(1).replace('.', ',')} s`;
  }

  if (status === 'running' || status === 'error') c.row.classList.add('is-open');
}

function openOnly(id) {
  for (const [key, c] of cards) c.row.classList.toggle('is-open', key === id);
}

function stepBody(id) {
  return cards.get(id).body;
}

function showStreamBox(id) {
  const body = stepBody(id);
  body.innerHTML = '';
  const box = el('pre', 'stream');
  body.append(box);
  return box;
}

function showError(id, message, raw) {
  setStepState(id, 'error', 'Erreur');
  const body = stepBody(id);
  body.append(el('p', 'error-box', message));
  if (raw) {
    const details = el('details', 'debug');
    details.append(el('summary', null, 'Voir la réponse brute du modèle'));
    const pre = el('pre');
    pre.textContent = raw;
    details.append(pre);
    body.append(details);
  }
  cards.get(id).row.classList.add('is-open');
}

function setProgress(done) {
  $('#progress').hidden = false;
  $('#progress-label').textContent = `${done} / ${STEPS.length} terminées`;
  $('#progress-bar').style.width = `${(done / STEPS.length) * 100}%`;
  $('#progress').classList.remove('is-paused');
}

/* ------------------------------------------------------------------ *
 * SSE over fetch (EventSource can't POST a body)
 * ------------------------------------------------------------------ */

async function runSse(endpoint, payload, handlers) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok || !response.body) {
    throw new Error(`Le serveur a répondu ${response.status}.`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let outcome = null;

  const dispatch = (rawEvent) => {
    let name = 'message';
    const dataLines = [];
    for (const line of rawEvent.split('\n')) {
      if (line.startsWith(':')) continue;
      if (line.startsWith('event:')) name = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (!dataLines.length) return;

    let data;
    try {
      data = JSON.parse(dataLines.join('\n'));
    } catch {
      return;
    }

    if (name === 'delta' && handlers.onDelta) handlers.onDelta(data.text || '');
    else if (name === 'status' && handlers.onStatus) handlers.onStatus(data.message || '');
    else if (name === 'done') outcome = { ok: true, result: data.result };
    else if (name === 'error') outcome = { ok: false, message: data.message, raw: data.raw };
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let split;
    while ((split = buffer.indexOf('\n\n')) !== -1) {
      dispatch(buffer.slice(0, split));
      buffer = buffer.slice(split + 2);
    }
  }
  if (buffer.trim()) dispatch(buffer);

  if (!outcome) throw new Error("Le flux s’est interrompu avant la fin de l’étape.");
  return outcome;
}

/**
 * Runs one pipeline step. Returns the parsed result, or null if it failed
 * (the failure is already rendered into the step card).
 */
async function runStep(step, payload) {
  setStepState(step.id, 'running', 'En cours…');
  openOnly(step.id);
  const box = showStreamBox(step.id);

  let outcome;
  try {
    outcome = await runSse(step.endpoint, payload, {
      onDelta: (text) => {
        box.textContent += text;
        box.scrollTop = box.scrollHeight;
      },
      onStatus: (message) => {
        cards.get(step.id).stateEl.textContent = message;
      },
    });
  } catch (err) {
    showError(step.id, err.message);
    return null;
  }

  if (!outcome.ok) {
    showError(step.id, outcome.message || 'Erreur inconnue.', outcome.raw);
    return null;
  }

  return outcome.result;
}

/* ------------------------------------------------------------------ *
 * Rendering the result of each step
 * ------------------------------------------------------------------ */

function section(body, title) {
  body.append(el('h4', 'step-section', title));
}

function list(body, items) {
  const ul = el('ul');
  ul.style.paddingLeft = '18px';
  (items || []).forEach((item) => ul.append(el('li', null, item)));
  body.append(ul);
}

function tags(body, items) {
  const wrap = el('div', 'tags');
  (items || []).forEach((item) => wrap.append(el('span', 'tag', item)));
  body.append(wrap);
}

/** Which of step 1's missing keywords actually made it into the rewrite. */
function keywordCoverageTags(body, rewriteResult) {
  const missing = (state.analysis && state.analysis.missing_keywords) || [];
  if (!missing.length) return;

  const haystack = [
    rewriteResult.summary_rewritten || '',
    ...(rewriteResult.skills_rewritten || []),
    ...((rewriteResult.experiences_rewritten || []).flatMap((e) => e.bullets || [])),
  ]
    .join(' \n ')
    .toLowerCase();

  section(body, 'Mots-clés de l’offre');
  const wrap = el('div', 'tags');
  missing.forEach((kw) => {
    const used = haystack.includes(String(kw).toLowerCase());
    wrap.append(el('span', used ? 'tag' : 'tag is-off', kw));
  });
  body.append(wrap);
}

function setStepDetail(id, text) {
  const c = cards.get(id);
  if (c) c.stateEl.textContent = text || '';
}

function renderAnalysis(result) {
  const body = stepBody(1);
  body.innerHTML = '';
  setStepDetail(1, [result.tone, result.company_name].filter(Boolean).join(' · '));

  const kv = el('div');
  const line = (label, value) => {
    const p = el('p', 'kv');
    p.append(el('strong', null, `${label} : `), document.createTextNode(value));
    kv.append(p);
  };
  line('Adéquation a priori', `${result.score}/100`);
  line('Entreprise', result.company_name || '—');
  line('Poste', result.role_title || '—');
  line('Format ATS recommandé', result.ats_format_recommended ? 'Oui' : 'Non');
  body.append(kv);

  if (typeof result.score === 'number' && result.score < 40) {
    body.append(
      el(
        'p',
        'hint',
        `Adéquation faible (${result.score}/100) — cette offre est probablement hors cible.`
      )
    );
  }

  if (result.score_justification) {
    section(body, 'Justification');
    body.append(el('p', null, result.score_justification));
  }

  section(body, 'Mots-clés manquants');
  tags(body, result.missing_keywords);

  if ((result.keyword_gaps || []).length) {
    section(body, 'Écarts non prouvés par le master (non ajoutés)');
    tags(body, result.keyword_gaps);
  }

  const flags = result.red_flags || [];
  if (flags.length) {
    section(body, "Signaux d'alerte");
    flags.forEach((f) => {
      const div = el('div', 'flag-box');
      div.append(el('strong', null, f.flag));
      div.append(el('div', 'flag-fix', `→ ${f.fix}`));
      body.append(div);
    });
  }

  const recommended = result.ats_format_recommended ? 'ats' : 'design';
  if (recommended !== state.format) {
    body.append(
      el(
        'p',
        'hint',
        `Le modèle recommande plutôt le format ${recommended === 'ats' ? 'ATS' : 'Design'}.`
      )
    );
  }
}

function renderRewrite(result) {
  const body = stepBody(2);
  body.innerHTML = '';
  const angle = (result._grounded && result._grounded.profil_angle) || 'defaut';
  setStepDetail(2, `Angle « ${angle} » · ${(result.experiences_rewritten || []).length} expérience(s) retenue(s)`);

  keywordCoverageTags(body, result);

  section(body, 'Profil retenu');
  body.append(el('p', null, result.summary_rewritten || '—'));

  section(body, 'Expériences retenues');
  (result.experiences_rewritten || []).forEach((exp) => {
    const div = el('div', 'flag-box');
    div.append(el('strong', null, exp.title || exp.id));
    const ul = el('ul');
    ul.style.paddingLeft = '18px';
    (exp.bullets || []).forEach((b) => ul.append(el('li', null, b)));
    div.append(ul);
    body.append(div);
  });

  section(body, 'Compétences');
  tags(body, result.skills_rewritten);

  if ((result.changes_summary || []).length) {
    section(body, 'Ce qui a été mis en avant');
    list(body, result.changes_summary);
  }
}

/**
 * Écrit `text` dans le bon champ du rewrite (profil, bullet d'expérience ou
 * compétence) — dans _grounded et dans la forme à plat que la génération lit.
 */
function patchRewrite(rw, field, text) {
  if (!rw) return;
  if (field === 'profil') {
    rw.summary_rewritten = text;
    return;
  }
  const g = rw._grounded || {};
  let m = field.match(/^exp:(.+):(\d+)$/);
  if (m) {
    const exp = (g.experiences || []).find((e) => e.id === m[1]);
    if (exp && exp.picked && exp.picked[+m[2]]) exp.picked[+m[2]].text = text;
    const er = (rw.experiences_rewritten || []).find((e) => e.id === m[1]);
    if (er && Array.isArray(er.bullets)) er.bullets[+m[2]] = text;
    return;
  }
  m = field.match(/^skill:(\d+)$/);
  if (m) {
    if ((g.skills || [])[+m[1]]) g.skills[+m[1]].text = text;
    if (Array.isArray(rw.skills_rewritten)) rw.skills_rewritten[+m[1]] = text;
  }
}

function renderVerify(result) {
  const body = stepBody(3);
  body.innerHTML = '';

  const st = result.stats || {};
  setStepDetail(
    3,
    result.clean
      ? `Rien d'inventé — ${st.verbatim || 0} verbatim, ${st.adapted || 0} reformulée(s)`
      : `${(result.violations_remaining || []).length} signalement(s) à relire`
  );

  const verdict = el('div', result.clean ? 'verdict is-clean' : 'verdict is-flagged');
  verdict.append(el('strong', null, result.clean ? '✓ Rien d’inventé' : '⚠ À relire avant envoi'));
  verdict.append(
    el(
      'div',
      'verdict-sub',
      `${st.verbatim || 0} ligne(s) reprises telles quelles · ${st.adapted || 0} reformulée(s)` +
        (result.repaired ? ' · une passe de correction appliquée' : '')
    )
  );
  body.append(verdict);

  const remaining = result.violations_remaining || [];
  if (remaining.length) {
    section(body, 'Signalements non résolus — à toi de choisir');
    remaining.forEach((v) => {
      const div = el('div', 'flag-box');
      div.append(el('strong', null, `${v.where} — ${v.kind}`));
      div.append(el('div', 'flag-fix', v.detail));

      const r = v.resolution;
      if (r) {
        // Par défaut on applique la version sûre (rien de non sourcé dans le PDF).
        patchRewrite(result.rewrite, r.field, r.safeText);

        const diff = el('div', 'diff-row');
        diff.append(el('div', 'diff-where', 'version sûre'));
        diff.append(el('div', 'diff-old', r.safeText || '(vide)'));
        diff.append(el('div', 'diff-where', 'version générée'));
        diff.append(el('div', 'diff-new', r.flaggedText));
        div.append(diff);

        const row = el('div', 'run-row');
        row.style.marginTop = '4px';
        const btn = el('button', 'btn btn-ghost btn-sm', '');
        btn.type = 'button';
        const status = el('span', 'sub');
        let kept = false;
        const sync = () => {
          status.textContent = kept
            ? '→ version générée conservée (tu confirmes que le fait est exact).'
            : '→ version sûre appliquée.';
          btn.textContent = kept ? 'Revenir à la version sûre' : 'Garder la version générée';
        };
        btn.addEventListener('click', () => {
          kept = !kept;
          patchRewrite(result.rewrite, r.field, kept ? r.flaggedText : r.safeText);
          sync();
        });
        sync();
        row.append(btn, status);
        div.append(row);
      } else if (v.sourceText) {
        const diff = el('div', 'diff-row');
        diff.append(el('div', 'diff-where', 'master'));
        diff.append(el('div', 'diff-old', v.sourceText));
        diff.append(el('div', 'diff-where', 'généré'));
        diff.append(el('div', 'diff-new', v.finalText));
        div.append(diff);
      }

      body.append(div);
    });
  }

  const found = result.violations_found || [];
  if (found.length && result.repaired) {
    const details = el('details', 'debug');
    details.append(el('summary', null, `${found.length} signalement(s) corrigés automatiquement`));
    found.forEach((v) => {
      const p = el('p', 'kv');
      p.textContent = `${v.where || v.ref} — ${v.detail || v.probleme}`;
      details.append(p);
    });
    body.append(details);
  }

  // Every adapted line, master vs final, so review is a glance not a re-read.
  const g = (result.rewrite && result.rewrite._grounded) || {};
  const rows = [];
  (g.experiences || []).forEach((exp) => {
    (exp.picked || []).forEach((p) => {
      if (p.changed) rows.push({ where: exp.id, from: p.sourceText, to: p.text });
    });
  });
  (g.skills || []).forEach((s) => {
    if (s.changed) rows.push({ where: 'compétence', from: s.sourceText, to: s.text });
  });

  if (rows.length) {
    section(body, 'Reformulations (master → CV généré)');
    rows.forEach((r) => {
      const div = el('div', 'diff-row');
      div.append(el('div', 'diff-where', r.where));
      div.append(el('div', 'diff-old', r.from));
      div.append(el('div'));
      div.append(el('div', 'diff-new', r.to));
      body.append(div);
    });
  }
}

function renderScore(result) {
  const body = stepBody(4);
  body.innerHTML = '';
  setStepDetail(4, `${result.score_avant} → ${result.score_apres}, détail en haut`);

  if (result.justification) {
    section(body, 'Pourquoi cet écart');
    body.append(el('p', null, result.justification));
  }

  if ((result.gains || []).length) {
    section(body, 'Ce que la version adaptée gagne');
    list(body, result.gains);
  }

  if ((result.restant || []).length) {
    section(body, 'Ce qui plafonne encore le score');
    result.restant.forEach((f) => {
      const div = el('div', 'flag-box');
      div.append(el('strong', null, f.fix));
      div.append(el('div', 'flag-fix', f.why));
      body.append(div);
    });
  }

  if ((result.ats_issues || []).length) {
    section(body, 'Parsing ATS');
    list(body, result.ats_issues);
  }

  const readyP = el('p', 'kv');
  readyP.append(el('strong', null, 'Prêt à générer : '), document.createTextNode(result.ready_to_generate ? 'Oui' : 'Non'));
  body.append(readyP);

  updateGauge(result.score_avant, result.justification, result.score_apres);
}

/**
 * Loads the fitted CV HTML into the preview iframe and makes it editable —
 * `contentEditable` on the whole document body, so any line becomes a text
 * field the moment it's clicked, with no need to instrument each field.
 */
function loadPreview(html) {
  const frame = $('#cv-preview-frame');
  frame.addEventListener(
    'load',
    () => {
      try {
        frame.contentDocument.body.contentEditable = 'true';
      } catch {
        /* srcdoc iframes are same-origin; this should never throw */
      }
    },
    { once: true }
  );
  frame.srcdoc = html;
}

function renderPreview(result) {
  const body = stepBody(5);
  body.innerHTML = '';
  setStepDetail(5, `Format ${state.format === 'ats' ? 'ATS' : 'design'}`);
  body.append(el('p', null, 'Aperçu généré ci-dessous — modifiable avant export.'));
  if (result.fitted === false) {
    body.append(el('p', 'hint is-error', 'Le contenu dépasse une page même réduit au minimum.'));
  }

  state.previewHtml = result.html;
  $('#preview-card').hidden = false;
  $('#preview-overflow-warning').hidden = result.fitted !== false;
  $('#download').hidden = true;
  loadPreview(result.html);
}

/** Shows the "PDF is ready" card — after an actual export, not the preview. */
function showDownload(result) {
  $('#download').hidden = false;
  $('#download-name').textContent = result.filename;
  const link = $('#download-link');
  link.href = result.url;
  link.setAttribute('download', result.filename);

  // Reset the tracking prompt for this new PDF — it re-appears every time
  // a fresh CV is generated, even if a previous one in this session was
  // already marked as sent.
  $('#track-prompt').hidden = false;
  $('#track-done').hidden = true;
}

/**
 * Exports whatever the person currently sees in the preview iframe — their
 * edits included. Those edits never go back through fact-checking: the
 * person owns anything they typed by hand.
 */
async function exportEditedPdf() {
  const btn = $('#export-pdf-btn');
  const frame = $('#cv-preview-frame');
  if (!frame.contentDocument || !frame.contentDocument.documentElement) return;

  const editedHtml = `<!DOCTYPE html>${frame.contentDocument.documentElement.outerHTML}`;

  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Export en cours…';
  $('#preview-overflow-warning').hidden = true;

  try {
    const res = await fetch('/api/export-pdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        html: editedHtml,
        lang: state.lang,
        format: state.format,
        analysis: state.analysis,
        rewrite: state.rewrite,
        websiteMode: state.websiteMode,
        jobOffer: $('#job-offer').value.trim(),
        scoreApres: state.score && state.score.score_apres,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Erreur inconnue.');

    state.pdf = data;
    showDownload(data);
    // Measured on the PDF itself, not on the layout that produced it.
    if ((data.pages !== null && data.pages > 1) || data.fitted === false) {
      $('#preview-overflow-warning').hidden = false;
      $('#preview-overflow-warning').textContent =
        data.pages > 1
          ? `Attention : le PDF fait ${data.pages} pages malgré les réductions.`
          : "Le contenu dépasse une page même réduit au minimum.";
    }
    saveLastRun();
    loadGenerations();
  } catch (err) {
    alert(`Export impossible : ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

$('#export-pdf-btn').addEventListener('click', exportEditedPdf);

function updateGauge(initial, justification, final) {
  $('#gauge').hidden = false;

  if (initial !== null && initial !== undefined) {
    $('#score-initial').textContent = initial;
    $('#gauge-before').style.width = `${Math.max(0, Math.min(100, initial))}%`;
  }
  if (justification) $('#score-justification').textContent = justification;

  if (final !== null && final !== undefined) {
    $('#score-final').textContent = final;
    $('#gauge-fill').style.width = `${Math.max(0, Math.min(100, final))}%`;
  }
}

/* ------------------------------------------------------------------ *
 * Manual-mode gate
 * ------------------------------------------------------------------ */

function waitForContinue(stepId) {
  return new Promise((resolve) => {
    const body = stepBody(stepId);
    const row = el('div', 'continue-row');
    const button = el('button', 'btn btn-primary btn-sm', 'Continuer →');
    button.type = 'button';
    button.addEventListener('click', () => {
      row.remove();
      resolve();
    });
    row.append(button);
    body.append(row);
    cards.get(stepId).row.classList.add('is-open');
  });
}

/* ------------------------------------------------------------------ *
 * Reopen last generation — a per-browser convenience (localStorage),
 * not a server-side record. Wrapped in try/catch throughout: private
 * browsing or a blocked/full store must never break the pipeline.
 * ------------------------------------------------------------------ */

const LAST_RUN_KEY = 'cv-optimizer:last-run';

function saveLastRun() {
  try {
    localStorage.setItem(LAST_RUN_KEY, JSON.stringify({
      jobOffer: $('#job-offer').value,
      lang: state.lang,
      format: state.format,
      websiteMode: state.websiteMode,
      analysis: state.analysis,
      rewrite: state.rewrite,
      verify: state.verify,
      score: state.score,
      previewHtml: state.previewHtml,
      pdf: state.pdf,
      savedAt: new Date().toISOString(),
    }));
  } catch {
    /* not critical — reopening is a convenience, not a guarantee */
  }
}

function loadLastRun() {
  try {
    const raw = localStorage.getItem(LAST_RUN_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function renderLastRunFooter() {
  const footer = $('#last-run');
  const saved = loadLastRun();
  if (!saved || !saved.analysis || !saved.previewHtml) {
    footer.hidden = true;
    return;
  }

  footer.hidden = false;
  footer.innerHTML = '';
  footer.append(el('span', 'steps-last-run-label', 'Dernière génération'));

  const dateTxt = saved.savedAt
    ? new Date(saved.savedAt).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })
    : '';
  const scoreTxt = saved.score ? ` Score ${saved.score.score_avant} → ${saved.score.score_apres}.` : '';
  const line = el('span', 'sub');
  line.textContent =
    `${saved.analysis.role_title || 'Poste'} — ${saved.analysis.company_name || 'Entreprise'}, ${dateTxt}.${scoreTxt} `;
  const link = el('button', 'link-btn', 'Rouvrir');
  link.type = 'button';
  link.addEventListener('click', () => reopenLastRun(saved));
  line.append(link);
  footer.append(line);
}

/** Replays a saved generation instantly — no API calls, just re-rendering. */
function reopenLastRun(saved) {
  $('#job-offer').value = saved.jobOffer || '';
  $('#job-offer').dispatchEvent(new Event('input'));
  state.lang = saved.lang || 'fr';
  state.format = saved.format || 'design';
  state.websiteMode = saved.websiteMode || 'none';
  langChip.setValue(state.lang);
  formatChip.setValue(state.format);
  websiteChip.setValue(state.websiteMode);
  updateModeHint();

  state.analysis = saved.analysis;
  state.rewrite = saved.rewrite;
  state.verify = saved.verify;
  state.score = saved.score;
  state.previewHtml = saved.previewHtml;
  state.pdf = saved.pdf;

  buildSteps();
  setStepState(1, 'done', '');
  renderAnalysis(saved.analysis);
  setStepState(2, 'done', '');
  if (saved.rewrite) renderRewrite(saved.rewrite);
  setStepState(3, 'done', '');
  if (saved.verify) renderVerify(saved.verify);
  setStepState(4, 'done', '');
  if (saved.score) renderScore(saved.score);
  setStepState(5, 'done', '');
  renderPreview({ html: saved.previewHtml, fitted: true });
  if (saved.pdf) showDownload(saved.pdf);
  setProgress(5);
  openOnly(5);
  $('#last-run').hidden = true;
}

/* ------------------------------------------------------------------ *
 * Dernières générations (côté serveur)
 *
 * The localStorage footer above reopens the last run in this browser,
 * without recomputing anything. This list is the server's own history:
 * it keeps the offer of the last 10 generations, so any of them can be
 * run again — on the current master CV, which is usually the point.
 * ------------------------------------------------------------------ */

async function loadGenerations() {
  const box = $('#generations');
  try {
    const res = await fetch('/api/generations');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Erreur inconnue.');
    renderGenerations(data.generations || []);
  } catch {
    box.hidden = true;
  }
}

function renderGenerations(generations) {
  const box = $('#generations');
  const list = $('#generations-list');
  if (!generations.length) {
    box.hidden = true;
    return;
  }

  box.hidden = false;
  list.innerHTML = '';
  generations.forEach((gen) => {
    const row = el('div', 'gen-row');
    row.append(el('span', 'gen-row-date', gen.date));

    const info = el('div', 'gen-row-info');
    info.append(el('span', 'gen-row-role', gen.role));
    info.append(
      el(
        'span',
        'gen-row-meta',
        [
          gen.company,
          String(gen.lang || '').toUpperCase(),
          gen.format === 'ats' ? 'ATS' : 'design',
          gen.scoreApres != null ? `score ${gen.scoreApres}` : '',
        ]
          .filter(Boolean)
          .join(' · ')
      )
    );
    row.append(info);

    const actions = el('div', 'gen-row-actions');
    if (gen.pdfUrl) {
      const link = el('a', 'btn btn-ghost btn-sm', 'PDF');
      link.href = gen.pdfUrl;
      link.target = '_blank';
      link.rel = 'noopener';
      actions.append(link);
    }
    const again = el('button', 'btn btn-line btn-sm', 'Régénérer');
    again.type = 'button';
    again.addEventListener('click', () => regenerateFrom(gen.id, again));
    actions.append(again);
    row.append(actions);

    list.append(row);
  });
}

/** Reloads a stored offer and its settings, then runs the pipeline again. */
async function regenerateFrom(id, button) {
  if (state.running) return;
  const label = button.textContent;
  button.disabled = true;
  button.textContent = 'Chargement…';
  try {
    const res = await fetch(`/api/generations/${id}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Erreur inconnue.');

    const gen = data.generation;
    $('#job-offer').value = gen.jobOffer || '';
    $('#job-offer').dispatchEvent(new Event('input'));
    state.lang = gen.lang || 'fr';
    state.format = gen.format || 'design';
    state.websiteMode = gen.websiteMode || 'none';
    langChip.setValue(state.lang);
    formatChip.setValue(state.format);
    websiteChip.setValue(state.websiteMode);
    updateModeHint();

    await runPipeline();
  } catch (err) {
    alert(err.message);
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

/* ------------------------------------------------------------------ *
 * Pipeline
 * ------------------------------------------------------------------ */

async function runPipeline() {
  $('#last-run').hidden = true;
  const jobOffer = $('#job-offer').value.trim();
  if (!jobOffer) {
    $('#run-hint').textContent = "Colle d'abord une offre d'emploi.";
    return;
  }

  const lang = state.lang;
  const format = state.format;
  const websiteMode = state.websiteMode;

  state.running = true;
  state.analysis = state.rewrite = state.verify = state.score = state.previewHtml = state.pdf = null;
  $('#run').disabled = true;
  $('#run-hint').textContent = 'Génération en cours…';
  $('#download').hidden = true;
  $('#preview-card').hidden = true;
  $('#gauge').hidden = true;
  $('#score-initial').textContent = '—';
  $('#score-final').textContent = '—';
  $('#score-justification').textContent = '';
  buildSteps();

  try {
    // Step 1 — analyse the offer ------------------------------------
    const analysis = await runStep(STEPS[0], { jobOffer });
    if (!analysis) return;
    state.analysis = analysis;
    setStepState(1, 'done', '');
    setProgress(1);
    renderAnalysis(analysis);
    if (state.mode === 'manuel') await waitForContinue(1);

    // Step 2 — grounded selection -----------------------------------
    const selection = await runStep(STEPS[1], { analysis, angle: state.angle === 'auto' ? undefined : state.angle });
    if (!selection) return;
    setStepState(2, 'done', '');
    setProgress(2);
    renderRewrite(selection);

    // Step 3 — fact-check, and repair what drifted -------------------
    const verify = await runStep(STEPS[2], { rewrite: selection });
    if (!verify) return;
    state.verify = verify;
    setStepState(3, 'done', '');
    setProgress(3);
    // Everything downstream uses the verified rewrite, not the raw one.
    const rewrite = verify.rewrite;
    state.rewrite = rewrite;
    renderVerify(verify);
    if (state.mode === 'manuel' || !verify.clean) await waitForContinue(3);

    // Step 4 — one comparative scoring pass --------------------------
    const score = await runStep(STEPS[3], { rewrite, jobOffer });
    if (!score) return;
    state.score = score;
    setStepState(4, 'done', '');
    setProgress(4);
    renderScore(score);
    if (state.mode === 'manuel') await waitForContinue(4);

    // Step 5 — editable preview ---------------------------------------
    const preview = await runStep(STEPS[4], {
      lang,
      format,
      analysis,
      rewrite,
      websiteMode,
      jobOffer,
      scoreApres: score && score.score_apres,
    });
    if (!preview) return;
    setStepState(5, 'done', '');
    setProgress(5);
    renderPreview(preview);
    openOnly(5);
    $('#run-hint').textContent = '';
    saveLastRun();
  } finally {
    state.running = false;
    $('#run').disabled = !$('#job-offer').value.trim();
  }
}

/* ------------------------------------------------------------------ *
 * Settings chips
 * ------------------------------------------------------------------ */

function updateModeHint() {
  const modeMsg =
    state.mode === 'auto'
      ? "Auto ne s'arrête que si la vérification signale quelque chose."
      : 'Validation manuelle après les étapes 1, 3 et 4.';
  const formatMsg =
    state.format === 'design'
      ? 'Design : deux colonnes avec sidebar et photo.'
      : 'ATS : colonne unique, sans site web.';
  $('#mode-hint').textContent = `${modeMsg} ${formatMsg}`;
}

const langChip = createChip('lang', [
  { value: 'fr', label: 'français' },
  { value: 'en', label: 'English' },
], (value) => { state.lang = value; });

const modeChip = createChip('mode-toggle', [
  { value: 'auto', label: 'auto' },
  { value: 'manuel', label: 'manuel' },
], (value) => { state.mode = value; updateModeHint(); });

const formatChip = createChip('format-toggle', [
  { value: 'design', label: 'design' },
  { value: 'ats', label: 'ATS' },
], (value) => { state.format = value; updateModeHint(); });

const websiteChip = createChip('website-mode', [
  { value: 'none', label: 'aucun' },
  { value: 'show', label: 'affiché' },
], (value) => { state.websiteMode = value; });

// Filled from the master's profil_variants once it loads (and again after
// each save) — createChip reads this array each time its menu opens.
const angleOptions = [{ value: 'auto', label: 'auto' }];
const angleChip = createChip('angle', angleOptions, (value) => { state.angle = value; });

async function loadAngleOptions() {
  try {
    const res = await fetch('/api/master-cv');
    if (!res.ok) return;
    const cv = await res.json();
    const angles = ['defaut', ...(cv.profil_variants || []).map((v) => v.angle).filter(Boolean)];
    angleOptions.splice(1, angleOptions.length, ...angles.map((a) => ({ value: a, label: a })));
    // An angle removed from the master falls back to auto.
    if (!angleOptions.some((o) => o.value === state.angle)) state.angle = 'auto';
    angleChip.setValue(state.angle);
  } catch {
    /* not critical — the chip stays on auto */
  }
}

updateModeHint();

/* Job offer: char counter + run-button enabled state --------------------- */
$('#job-offer').addEventListener('input', () => {
  const text = $('#job-offer').value;
  $('#offer-count').textContent = text.trim() ? `${text.length} caractères` : 'Colle l’offre ici';
  const has = !!text.trim();
  $('#run').disabled = !has || state.running;
  $('#run-hint').textContent = has ? '' : 'Colle une offre pour commencer.';
});

/* ------------------------------------------------------------------ *
 * Accordions — annex tools
 * ------------------------------------------------------------------ */

document.querySelectorAll('.accordion-item').forEach((item) => {
  item.querySelector('.accordion-head').addEventListener('click', () => {
    item.classList.toggle('is-open');
  });
});

/* ------------------------------------------------------------------ *
 * Master CV editor
 * ------------------------------------------------------------------ */

// Keeps the photo data URL separate so it never bloats the textarea.
let _masterPhoto = null;
let _masterName = '';

/**
 * CodeMirror wraps #master-text on first use (fromTextArea hides the
 * original element and inserts a sibling .CodeMirror div) — every read/
 * write of the JSON body goes through this instance from then on, never
 * through $('#master-text').value directly.
 */
let _masterEditor = null;
function masterEditor() {
  if (!_masterEditor) {
    _masterEditor = CodeMirror.fromTextArea($('#master-text'), {
      mode: { name: 'javascript', json: true },
      lineNumbers: false,
      lineWrapping: true,
      viewportMargin: Infinity,
    });
  }
  return _masterEditor;
}

function initialsOf(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
}

function updatePhotoPreview(dataUrl) {
  const preview = $('#photo-preview');
  const initials = $('#photo-initials');
  const removeBtn = $('#photo-remove');
  if (dataUrl) {
    preview.src = dataUrl;
    preview.hidden = false;
    initials.hidden = true;
    removeBtn.hidden = false;
  } else {
    preview.hidden = true;
    preview.removeAttribute('src');
    initials.hidden = false;
    initials.textContent = initialsOf(_masterName);
    removeBtn.hidden = true;
  }
}

/** Updates the stored photo and refreshes the preview — does NOT touch the textarea. */
function setMasterPhoto(dataUrl) {
  _masterPhoto = dataUrl || null;
  updatePhotoPreview(_masterPhoto);
}

/** Downscales an image file to keep the embedded base64 payload small. */
function resizeImageFile(file, maxSize = 480, quality = 0.85) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', quality));
      URL.revokeObjectURL(img.src);
    };
    img.onerror = () => reject(new Error("Impossible de lire l'image."));
    img.src = URL.createObjectURL(file);
  });
}

$('#photo-input').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;
  try {
    const dataUrl = await resizeImageFile(file);
    setMasterPhoto(dataUrl);
    $('#master-msg').textContent = 'Photo prête — clique sur Enregistrer pour la sauvegarder.';
    $('#master-msg').className = 'modal-msg';
  } catch (err) {
    $('#master-msg').textContent = err.message;
    $('#master-msg').className = 'modal-msg is-error';
  }
});

$('#photo-remove').addEventListener('click', () => {
  setMasterPhoto(null);
  $('#master-msg').textContent = 'Photo retirée — clique sur Enregistrer pour confirmer.';
  $('#master-msg').className = 'modal-msg';
});

/** Counts "[FIXE] " occurrences and top-level content, for the side summary. */
function updateMasterSummary(data) {
  const fixedCount = (JSON.stringify(data).match(/\[FIXE\]/g) || []).length;
  $('#master-locked-count').textContent = `${fixedCount} champ(s) verrouillé(s) actuellement.`;
  $('#master-summary').textContent =
    `${(data.experiences || []).length} expérience(s), ${(data.education || []).length} formation(s), ` +
    `${(data.competences || []).length} compétence(s), ${(data.langues || []).length} langue(s).`;
}

async function openMasterEditor() {
  const msg = $('#master-msg');
  msg.textContent = 'Chargement…';
  msg.className = 'modal-msg';
  $('#master-modal').hidden = false;
  try {
    const response = await fetch('/api/master-cv');
    const data = await response.json();
    // Store photo separately and strip it from the textarea so it stays readable.
    _masterPhoto = (data.personal && data.personal.photo) || null;
    _masterName = (data.personal && data.personal.name) || '';
    const display = JSON.parse(JSON.stringify(data));
    if (display.personal) delete display.personal.photo;
    masterEditor().setValue(JSON.stringify(display, null, 2));
    masterEditor().refresh();
    updatePhotoPreview(_masterPhoto);
    updateMasterSummary(data);
    msg.textContent = '';
  } catch (err) {
    msg.textContent = 'Impossible de charger master-cv.json.';
    msg.className = 'modal-msg is-error';
  }
}

$('#edit-master').addEventListener('click', openMasterEditor);
$('#master-close').addEventListener('click', () => { $('#master-modal').hidden = true; });
$('#master-close-2').addEventListener('click', () => { $('#master-modal').hidden = true; });

/* --- Tab toggle: JSON ↔ Texte libre --- */
function switchTab(tab) {
  const isJson = tab === 'json';
  $('#tab-json').classList.toggle('is-active', isJson);
  $('#tab-text').classList.toggle('is-active', !isJson);
  $('#json-panel').hidden = !isJson;
  $('#freetext-panel').hidden = isJson;
  $('#master-save').disabled = !isJson;
  $('#master-msg').textContent = '';
}

$('#tab-json').addEventListener('click', () => switchTab('json'));
$('#tab-text').addEventListener('click', () => switchTab('text'));

/* --- Structurer avec IA --- */
$('#parse-cv-btn').addEventListener('click', async () => {
  const msg = $('#master-msg');
  const text = $('#freetext-input').value.trim();
  if (!text) {
    msg.textContent = 'Colle du texte avant de structurer.';
    msg.className = 'modal-msg is-error';
    return;
  }
  const btn = $('#parse-cv-btn');
  btn.disabled = true;
  btn.textContent = 'Structuration en cours…';
  msg.textContent = 'Claude analyse ton texte…';
  msg.className = 'modal-msg';

  try {
    const response = await fetch('/api/parse-cv', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Échec de la structuration.');

    // Inject back the existing photo into the parsed result
    const parsed = data.data;
    parsed.personal = parsed.personal || {};
    parsed.personal.photo = _masterPhoto;

    // Switch to JSON tab with the result ready to review
    const display = JSON.parse(JSON.stringify(parsed));
    delete display.personal.photo;
    masterEditor().setValue(JSON.stringify(display, null, 2));
    _masterName = parsed.personal.name || '';
    updateMasterSummary(parsed);
    switchTab('json');
    msg.textContent = 'CV structuré — vérifie le JSON puis clique sur Enregistrer.';
    msg.className = 'modal-msg is-ok';

    // Keep the parsed result with photo for the save handler
    _masterPhoto = parsed.personal.photo || null;
  } catch (err) {
    msg.textContent = err.message;
    msg.className = 'modal-msg is-error';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Structurer avec Claude';
  }
});

$('#master-save').addEventListener('click', async () => {
  const msg = $('#master-msg');
  const content = masterEditor().getValue();

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    msg.textContent = `JSON invalide : ${err.message}`;
    msg.className = 'modal-msg is-error';
    return;
  }

  // Re-inject the stored photo before saving (not visible in the textarea).
  parsed.personal = parsed.personal || {};
  parsed.personal.photo = _masterPhoto;

  msg.textContent = 'Enregistrement…';
  msg.className = 'modal-msg';

  try {
    const response = await fetch('/api/master-cv', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: JSON.stringify(parsed) }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Échec de l\'enregistrement.');
    msg.textContent = 'Enregistré.';
    msg.className = 'modal-msg is-ok';
    updateMasterSummary(parsed);
    loadMasterUpdatedAt();
    loadAngleOptions();
  } catch (err) {
    msg.textContent = err.message;
    msg.className = 'modal-msg is-error';
  }
});

/** Topbar "Master CV mis à jour le …" — reads the Last-Modified response header. */
async function loadMasterUpdatedAt() {
  try {
    const res = await fetch('/api/master-cv', { method: 'HEAD' });
    const lm = res.headers.get('Last-Modified');
    if (!lm) return;
    const d = new Date(lm);
    const label = d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
    $('#master-updated').textContent = `Master CV mis à jour le ${label}`;
  } catch {
    /* not critical — leave the topbar line blank */
  }
}

/* ------------------------------------------------------------------ *
 * Application question answerer (Welcome to the Jungle, etc.)
 * ------------------------------------------------------------------ */

async function generateAnswer() {
  const question = $('#app-question').value.trim();
  const jobOffer = $('#job-offer').value.trim();
  const lang = state.lang;
  const msg = $('#answer-msg');
  const btn = $('#answer-question-btn');

  if (!question) {
    msg.textContent = 'Colle une question d\'abord.';
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Génération…';
  msg.textContent = '';
  $('#answer-box').hidden = true;

  try {
    const res = await fetch('/api/answer-question', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, jobOffer, lang }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Erreur inconnue.');
    $('#answer-output').value = data.answer;
    $('#answer-box').hidden = false;
    msg.textContent = `Réponse prête, ${data.answer.length} caractères.`;
  } catch (err) {
    msg.textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Générer une réponse';
  }
}

$('#answer-question-btn').addEventListener('click', generateAnswer);
$('#regen-answer-btn').addEventListener('click', generateAnswer);

$('#copy-answer-btn').addEventListener('click', async () => {
  const output = $('#answer-output');
  await navigator.clipboard.writeText(output.value);
  const msg = $('#answer-msg');
  const previous = msg.textContent;
  msg.textContent = 'Copié !';
  setTimeout(() => { msg.textContent = previous; }, 1500);
});

$('#shorten-answer-btn').addEventListener('click', async () => {
  await shortenInto('#answer-output', '#answer-msg', '#shorten-answer-btn');
});

/* ------------------------------------------------------------------ *
 * Cover letter
 * ------------------------------------------------------------------ */

async function generateLetter() {
  const jobOffer = $('#job-offer').value.trim();
  const notes = $('#letter-notes').value.trim();
  const lang = state.lang;
  const msg = $('#letter-msg');
  const btn = $('#letter-btn');

  if (!jobOffer) {
    msg.textContent = "Colle d'abord une offre d'emploi.";
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Rédaction…';
  msg.textContent = '';
  $('#letter-box').hidden = true;

  try {
    const res = await fetch('/api/cover-letter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobOffer, notes, lang }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Erreur inconnue.');
    $('#letter-output').value = data.lettre;
    $('#letter-box').hidden = false;
    msg.textContent = data.objet ? `Objet suggéré : ${data.objet}` : 'Lettre prête.';
  } catch (err) {
    msg.textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Rédiger la lettre';
  }
}

$('#letter-btn').addEventListener('click', generateLetter);
$('#regen-letter-btn').addEventListener('click', generateLetter);

$('#copy-letter-btn').addEventListener('click', async () => {
  await navigator.clipboard.writeText($('#letter-output').value);
  const msg = $('#letter-msg');
  const previous = msg.textContent;
  msg.textContent = 'Copié !';
  setTimeout(() => { msg.textContent = previous; }, 1500);
});

$('#shorten-letter-btn').addEventListener('click', async () => {
  await shortenInto('#letter-output', '#letter-msg', '#shorten-letter-btn');
});

/** Shared by both tools' "Plus court" button: shrinks a textarea's own content in place. */
async function shortenInto(outputSelector, msgSelector, btnSelector) {
  const output = $(outputSelector);
  const msg = $(msgSelector);
  const btn = $(btnSelector);
  const text = output.value.trim();
  if (!text) return;

  btn.disabled = true;
  btn.textContent = 'Raccourcissement…';
  try {
    const res = await fetch('/api/shorten', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Erreur inconnue.');
    output.value = data.text;
    msg.textContent = `Raccourci, ${data.text.length} caractères.`;
  } catch (err) {
    msg.textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Plus court';
  }
}

/* ------------------------------------------------------------------ *
 * View tabs — Générer / Suivi des candidatures
 * ------------------------------------------------------------------ */

$('#view-tabs').addEventListener('click', (event) => {
  const button = event.target.closest('.view-tab');
  if (!button) return;
  const view = button.dataset.view;

  $('#view-tabs').querySelectorAll('.view-tab').forEach((b) => {
    const active = b === button;
    b.classList.toggle('is-active', active);
    b.setAttribute('aria-selected', String(active));
  });
  $('#view-generate').hidden = view !== 'generate';
  $('#view-tracking').hidden = view !== 'tracking';

  if (view === 'tracking') loadApplications();
});

/* ------------------------------------------------------------------ *
 * Suivi des candidatures
 * ------------------------------------------------------------------ */

const STATUS_LABELS = { envoyee: 'Envoyée', refusee: 'Refusée', acceptee: 'Acceptée' };
let _applications = [];
let _appFilter = 'all';

function applicationRow(app) {
  const row = el('div', `app-row${app.status === 'acceptee' ? ' is-acceptee' : ''}`);
  row.append(el('span', 'app-row-date', app.date));

  const info = el('div', 'app-row-info');
  info.append(el('span', 'app-row-role', app.role));

  const detailParts = [app.company];
  if (app.scoreAvant != null && app.scoreApres != null) {
    detailParts.push(`Score ${app.scoreAvant} → ${app.scoreApres}`);
  }
  if (app.format) detailParts.push(`format ${app.format === 'ats' ? 'ATS' : 'design'}`);
  info.append(el('span', 'app-row-company', detailParts.join(' · ')));

  const interviewRow = el('div', 'app-row-interview');
  if (app.interviewDate) {
    interviewRow.append(el('span', 'sub', `Entretien le ${app.interviewDate}`));
    const clear = el('button', 'link-btn', 'retirer');
    clear.type = 'button';
    clear.addEventListener('click', () => patchApplication(app.id, { interviewDate: null }));
    interviewRow.append(clear);
  } else {
    const addBtn = el('button', 'link-btn', "+ date d'entretien");
    addBtn.type = 'button';
    addBtn.addEventListener('click', () => {
      interviewRow.innerHTML = '';
      const input = el('input');
      input.type = 'date';
      input.addEventListener('change', () => {
        if (input.value) patchApplication(app.id, { interviewDate: input.value });
      });
      interviewRow.append(input);
      input.focus();
    });
    interviewRow.append(addBtn);
  }
  info.append(interviewRow);

  // The offer this CV was written for, kept with it and folded away until
  // asked for: it is the only thing that explains the wording months later.
  if (app.jobOffer) {
    const offerWrap = el('div', 'app-row-offer');
    const toggle = el('button', 'link-btn', "Voir l'offre");
    toggle.type = 'button';
    const pre = el('pre', 'app-offer-text', app.jobOffer);
    pre.hidden = true;
    toggle.addEventListener('click', () => {
      pre.hidden = !pre.hidden;
      toggle.textContent = pre.hidden ? "Voir l'offre" : "Masquer l'offre";
    });
    offerWrap.append(toggle, pre);
    info.append(offerWrap);
  }

  row.append(info);

  row.append(el('span', `stamp s-${app.status}`, STATUS_LABELS[app.status] || app.status));

  const actions = el('div', 'app-row-actions');
  if (app.pdfUrl) {
    const link = el('a', 'btn btn-ghost btn-sm', 'PDF');
    link.href = app.pdfUrl;
    link.target = '_blank';
    link.rel = 'noopener';
    actions.append(link);
  }
  if (app.status === 'envoyee') {
    const refuse = el('button', 'btn btn-ghost btn-sm btn-danger', 'Refusée');
    refuse.type = 'button';
    refuse.addEventListener('click', () => updateApplicationStatus(app.id, 'refusee'));
    const accept = el('button', 'btn btn-ghost btn-sm btn-ok', 'Acceptée');
    accept.type = 'button';
    accept.addEventListener('click', () => updateApplicationStatus(app.id, 'acceptee'));
    actions.append(refuse, accept);
  } else {
    const reset = el('button', 'btn btn-ghost btn-sm', 'Remettre en envoyée');
    reset.type = 'button';
    reset.addEventListener('click', () => updateApplicationStatus(app.id, 'envoyee'));
    actions.append(reset);
  }
  row.append(actions);

  return row;
}

function renderApplicationsSummary() {
  const total = _applications.length;
  const counts = { envoyee: 0, refusee: 0, acceptee: 0 };
  _applications.forEach((a) => { counts[a.status] = (counts[a.status] || 0) + 1; });

  $('#tracking-count').hidden = total === 0;
  $('#tracking-count').textContent = total;

  const summary = $('#tracking-summary');
  if (!total) {
    summary.textContent = 'Aucune candidature suivie pour l’instant.';
    return;
  }
  summary.innerHTML = '';
  summary.append(el('b', null, String(total)), document.createTextNode(' candidature(s) suivie(s), '));
  summary.append(el('b', null, String(counts.acceptee)), document.createTextNode(' acceptée(s), '));
  summary.append(el('b', null, String(counts.refusee)), document.createTextNode(' refusée(s), '));
  summary.append(el('b', null, String(counts.envoyee)), document.createTextNode(' sans réponse.'));
}

function renderApplicationsList() {
  const container = $('#applications-list');
  container.innerHTML = '';
  const filtered = _appFilter === 'all' ? _applications : _applications.filter((a) => a.status === _appFilter);
  if (!filtered.length) {
    container.append(el('p', 'hint', 'Rien à afficher pour ce filtre.'));
    return;
  }
  filtered.forEach((app) => container.append(applicationRow(app)));
}

async function loadApplications() {
  const container = $('#applications-list');
  container.innerHTML = '';
  container.append(el('p', 'hint', 'Chargement…'));

  try {
    const res = await fetch('/api/applications');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Erreur inconnue.');
    _applications = data.applications;
    renderApplicationsSummary();
    renderApplicationsList();
  } catch (err) {
    container.innerHTML = '';
    container.append(el('p', 'hint is-error', err.message));
  }
}

$('#tracking-filters').addEventListener('click', (event) => {
  const button = event.target.closest('.filter-btn');
  if (!button) return;
  _appFilter = button.dataset.filter;
  $('#tracking-filters').querySelectorAll('.filter-btn').forEach((b) => b.classList.toggle('is-active', b === button));
  renderApplicationsList();
});

/** patch is {status} and/or {interviewDate} — same PATCH endpoint for both. */
async function patchApplication(id, patch) {
  try {
    const res = await fetch(`/api/applications/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Erreur inconnue.');
    await loadApplications();
  } catch (err) {
    alert(err.message);
  }
}

const updateApplicationStatus = (id, status) => patchApplication(id, { status });

$('#track-yes').addEventListener('click', async () => {
  const btn = $('#track-yes');
  btn.disabled = true;
  btn.textContent = 'Ajout…';
  try {
    const res = await fetch('/api/applications', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        company: state.analysis && state.analysis.company_name,
        role: state.analysis && state.analysis.role_title,
        pdfFilename: state.pdf && state.pdf.filename,
        pdfUrl: state.pdf && state.pdf.url,
        lang: state.lang,
        scoreAvant: state.score && state.score.score_avant,
        scoreApres: state.score && state.score.score_apres,
        format: state.format,
        jobOffer: $('#job-offer').value,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Erreur inconnue.');
    $('#track-prompt').hidden = true;
    $('#track-done').hidden = false;
  } catch (err) {
    alert(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Oui, l'ajouter au suivi";
  }
});

$('#track-no').addEventListener('click', () => {
  $('#track-prompt').hidden = true;
});

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

$('#run').addEventListener('click', runPipeline);
buildSteps();
loadMasterUpdatedAt();
loadAngleOptions();
renderLastRunFooter();
loadGenerations();
