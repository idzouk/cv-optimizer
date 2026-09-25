'use strict';

const fs = require('fs');
const { atomicWriteJson } = require('./util');

/* ------------------------------------------------------------------ *
 * Dernières générations
 *
 * A CV is only reproducible if the offer that shaped it was kept. The
 * tracking tab keeps the offer of every application that was actually
 * sent; this keeps the last few of everything else — including the runs
 * that never became an application — so a generation can be replayed
 * from its own offer instead of hunting the job board for it again.
 *
 * Deliberately a short, bounded history: it is a rollback buffer, not an
 * archive, and each entry carries a full job offer.
 * ------------------------------------------------------------------ */

const MAX_GENERATIONS = 10;

function randomId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** The fields the list view needs — everything but the heavy payloads. */
function summarize(entry) {
  return {
    id: entry.id,
    date: entry.date,
    createdAt: entry.createdAt,
    company: entry.company,
    role: entry.role,
    lang: entry.lang,
    format: entry.format,
    websiteMode: entry.websiteMode,
    pdfFilename: entry.pdfFilename,
    pdfUrl: entry.pdfUrl,
    scoreApres: entry.scoreApres,
  };
}

function createGenerationsStore(generationsPath, { max = MAX_GENERATIONS } = {}) {
  /** Reads the history. A missing or unreadable file is an empty one: this
   *  is a convenience buffer and must never break a generation. */
  function readGenerations() {
    if (!fs.existsSync(generationsPath)) return [];
    try {
      const list = JSON.parse(fs.readFileSync(generationsPath, 'utf8'));
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }

  function listGenerations() {
    return readGenerations().map(summarize);
  }

  function getGeneration(id) {
    return readGenerations().find((g) => g.id === id) || null;
  }

  /**
   * Records one finished generation, newest first, dropping the oldest
   * past `max`. The offer is what makes the entry worth keeping, so an
   * entry without one is refused rather than silently stored.
   */
  async function addGeneration({
    company,
    role,
    lang,
    format,
    websiteMode,
    jobOffer,
    analysis,
    rewrite,
    scoreApres,
    pdfFilename,
    pdfUrl,
  }) {
    if (!jobOffer || !String(jobOffer).trim()) {
      const err = new Error('"jobOffer" est requis pour enregistrer une génération.');
      err.status = 400;
      throw err;
    }

    const entry = {
      id: randomId(),
      company: company || 'Entreprise non précisée',
      role: role || 'Poste non précisé',
      lang: lang || 'fr',
      format: format || null,
      websiteMode: websiteMode || null,
      jobOffer: String(jobOffer),
      // Kept so a replay can skip straight to the PDF if nothing changed,
      // and so the stored offer can be read back next to what it produced.
      analysis: analysis || null,
      rewrite: rewrite || null,
      scoreApres: typeof scoreApres === 'number' ? scoreApres : null,
      pdfFilename: pdfFilename || null,
      pdfUrl: pdfUrl || null,
      date: new Date().toISOString().slice(0, 10),
      createdAt: new Date().toISOString(),
    };

    const list = [entry, ...readGenerations()].slice(0, max);
    await atomicWriteJson(generationsPath, list);
    return entry;
  }

  return { readGenerations, listGenerations, getGeneration, addGeneration };
}

module.exports = { MAX_GENERATIONS, createGenerationsStore };
