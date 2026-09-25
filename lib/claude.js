'use strict';

const { stripFences } = require('./util');

const SYSTEM_PROMPT =
  "Tu es un recruteur senior et un expert ATS avec 15 ans d'expérience en conseil, marketing " +
  "digital et IA. Tu as trié des milliers de CVs et tu sais, en dix secondes, lesquels " +
  "provoquent un appel et lesquels finissent à la corbeille. Ta mission n'est pas de rendre un " +
  "CV \"plus joli\" : c'est de maximiser la probabilité que CE candidat précis reçoive un appel " +
  "pour CE poste précis. Tu es direct, exigeant, sans complaisance. " +
  "Tu ne fabriques jamais de faits : chiffres, résultats, outils, clients et responsabilités " +
  "doivent provenir du CV master fourni. Reformuler, prioriser, mettre en avant, oui ; inventer " +
  "ou exagérer, jamais — le candidat devra défendre chaque ligne en entretien. " +
  "Réponds UNIQUEMENT en JSON valide, sans markdown, sans texte autour.";

const TRANSLATE_SYSTEM_PROMPT =
  "Tu es un traducteur professionnel FR→EN spécialisé dans les CVs et documents RH pour le " +
  "marché anglo-saxon. Tu traduis fidèlement : aucun fait, chiffre, nom propre, outil ou nuance " +
  "de sens n'est ajouté, retiré ou exagéré. Réponds UNIQUEMENT en JSON valide, sans markdown, " +
  "sans texte autour.";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Builds a message's `content`. With no cachedPrefix, this is a plain
 * string — identical to before caching existed. With one, the prefix
 * becomes its own block carrying `cache_control`, so Anthropic caches
 * everything up to and including it: a later call whose *entire* prefix
 * matches — same system prompt, same tools (if any), and this same
 * cachedPrefix text — reads it back at ~10% of its input-token cost
 * instead of reprocessing it. Only that prefix needs to match
 * byte-for-byte; userPrompt is free to vary every time.
 *
 * The API concatenates consecutive text blocks with no separator of its
 * own, so the trailing "\n\n" here is load-bearing: without it, the last
 * word of cachedPrefix runs straight into the first word of userPrompt
 * (e.g. "...urbanismeVoici l'offre" with no space at all).
 *
 * The master CV text is the natural fit for cachedPrefix: it's identical
 * across every step of one generation (and across generations, until
 * it's edited), and large enough to clear the ~1024-token minimum the
 * API requires for a block to actually be cached.
 */
function buildContent(cachedPrefix, userPrompt) {
  if (!cachedPrefix) return userPrompt;
  return [
    { type: 'text', text: `${cachedPrefix}\n\n`, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: userPrompt },
  ];
}

/** Logs what the cache actually did on this call — visible proof it's working. */
function logCacheUsage(label, usage) {
  if (!usage) return;
  const { cache_creation_input_tokens: created, cache_read_input_tokens: read } = usage;
  if (created) console.log(`  [cache] ${label}: écriture de ${created} tokens dans le cache`);
  if (read) console.log(`  [cache] ${label}: lecture de ${read} tokens depuis le cache (~90% moins cher)`);
}

function openSse(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');
}

function sse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

/** Parse the model's JSON, or emit an SSE error carrying the raw text for the debug panel. */
function parseModelJson(res, raw) {
  try {
    return JSON.parse(stripFences(raw));
  } catch (err) {
    sse(res, 'error', {
      message: "La réponse du modèle n'est pas un JSON valide.",
      raw,
    });
    res.end();
    return null;
  }
}

/**
 * Bound Claude client for one (anthropic instance, model) pair — everything
 * downstream calls streamClaude/callClaudeJson/friendlyError without
 * re-threading those two through every call site.
 */
function createClaudeService({ anthropic, model }) {
  /** Turn an SDK/network error into something safe to show a human. */
  function friendlyError(err) {
    const status = err && err.status;
    if (status === 401) return "Clé API invalide ou manquante. Vérifie ANTHROPIC_API_KEY dans le fichier .env.";
    if (status === 403) return "Cette clé API n'a pas accès à ce modèle.";
    if (status === 404) return `Modèle introuvable (${model}). Vérifie l'identifiant du modèle.`;
    if (status === 413) return 'La requête est trop volumineuse — raccourcis l’offre d’emploi.';
    if (status === 429) return 'Limite de débit atteinte. Réessaie dans une minute.';
    if (status && status >= 500) return 'L’API Anthropic est momentanément indisponible. Réessaie dans un instant.';
    if (err && err.name === 'APIConnectionError') return 'Impossible de joindre l’API Anthropic — vérifie ta connexion.';
    return (err && err.message) || 'Erreur inattendue.';
  }

  /**
   * Streams a Claude completion, forwarding text deltas over SSE,
   * and returns the full raw text.
   */
  async function streamClaude({ res, userPrompt, cachedPrefix, maxTokens = 8000 }) {
    const run = async () => {
      const stream = anthropic.messages.stream({
        model,
        max_tokens: maxTokens,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: buildContent(cachedPrefix, userPrompt) }],
      });

      stream.on('text', (delta) => sse(res, 'delta', { text: delta }));

      const message = await stream.finalMessage();
      logCacheUsage('streamClaude', message.usage);

      if (message.stop_reason === 'refusal') {
        const err = new Error("Le modèle a refusé de traiter cette demande.");
        err.status = 200;
        throw err;
      }
      if (message.stop_reason === 'max_tokens') {
        const err = new Error('Réponse tronquée (limite de tokens atteinte). Réessaie avec une offre plus courte.');
        throw err;
      }
      // streamClaude never passes `tools`, so this should never fire — it's a
      // trip wire, not a real code path. Without it, a future change that
      // adds tools here would have its tool_use block silently swallowed by
      // the `type === 'text'` filter below, returning empty/truncated text
      // instead of failing loudly.
      if (message.stop_reason === 'tool_use') {
        throw new Error('Réponse en tool_use reçue sur un appel texte — streamClaude ne sait pas la traiter.');
      }

      return message.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('');
    };

    try {
      return await run();
    } catch (err) {
      if (err && err.status === 429) {
        sse(res, 'status', { message: 'Limite de débit atteinte — nouvelle tentative dans 5 s…' });
        await sleep(5000);
        return run();
      }
      throw err;
    }
  }

  /**
   * One-shot (non-streamed) Claude call used for the FR→EN translation pass,
   * the semantic fact-check, and the small side endpoints (parse-cv,
   * answer-question, cover-letter). Not exposed over SSE as its own
   * pipeline step, so failures are caught by the caller.
   */
  async function callClaudeJson({ system, userPrompt, maxTokens = 4000 }) {
    const run = () =>
      anthropic.messages.create({
        model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: userPrompt }],
      });

    let message;
    try {
      message = await run();
    } catch (err) {
      if (err && err.status === 429) {
        await sleep(5000);
        message = await run();
      } else {
        throw err;
      }
    }

    const raw = message.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');
    return JSON.parse(stripFences(raw));
  }

  /**
   * Like callClaudeJson, but structured through real tool use instead of a
   * "respond in JSON" instruction: `tool` is one Anthropic tool definition
   * ({name, description, input_schema}), forced via tool_choice so Claude
   * can only reply by calling it. No stripFences/JSON.parse guesswork —
   * `input` on the tool_use block is already the parsed, schema-shaped
   * object the SDK built for us.
   */
  async function callClaudeTool({ system, userPrompt, cachedPrefix, tool, maxTokens = 4000 }) {
    const run = () =>
      anthropic.messages.create({
        model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: buildContent(cachedPrefix, userPrompt) }],
        tools: [tool],
        tool_choice: { type: 'tool', name: tool.name },
      });

    let message;
    try {
      message = await run();
    } catch (err) {
      if (err && err.status === 429) {
        await sleep(5000);
        message = await run();
      } else {
        throw err;
      }
    }
    logCacheUsage(`callClaudeTool:${tool.name}`, message.usage);

    if (message.stop_reason !== 'tool_use') {
      throw new Error(`Réponse inattendue du modèle (stop_reason: ${message.stop_reason}).`);
    }
    const block = message.content.find((b) => b.type === 'tool_use' && b.name === tool.name);
    if (!block) throw new Error(`Le modèle n'a pas appelé l'outil "${tool.name}".`);
    return block.input;
  }

  return { streamClaude, callClaudeJson, callClaudeTool, friendlyError };
}

module.exports = {
  SYSTEM_PROMPT,
  TRANSLATE_SYSTEM_PROMPT,
  createClaudeService,
  openSse,
  sse,
  parseModelJson,
  buildContent,
};
