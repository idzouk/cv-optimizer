'use strict';

const fs = require('fs');
const { atomicWriteJson } = require('./util');

/**
 * Only two things are tracked once a CV is sent: whether it landed a call,
 * or didn't. No pipeline of intermediate stages — status stays just these
 * three. An interview date is captured as a plain optional note on
 * the entry, not a fourth status, so it stays skippable.
 */
const STATUSES = ['envoyee', 'refusee', 'acceptee'];

function randomId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Bound reader/writer for one applications.json path. The file doesn't
 * need to exist ahead of time — reading before the first application is
 * ever tracked returns an empty list, and the first write creates it.
 */
function createApplicationsStore(applicationsPath) {
  function readApplications() {
    if (!fs.existsSync(applicationsPath)) return [];
    return JSON.parse(fs.readFileSync(applicationsPath, 'utf8'));
  }

  /** Records a CV as sent. Called once, right after a successful download. */
  async function addApplication({ company, role, pdfFilename, pdfUrl, lang, scoreAvant, scoreApres, format, jobOffer }) {
    if (!pdfFilename) {
      const err = new Error('"pdfFilename" est requis.');
      err.status = 400;
      throw err;
    }

    const entry = {
      id: randomId(),
      company: company || 'Entreprise non précisée',
      role: role || 'Poste non précisé',
      pdfFilename,
      pdfUrl: pdfUrl || null,
      lang: lang || 'fr',
      format: format || null,
      // The offer is kept with the application: months later, "why did this
      // CV say that?" is only answerable against the offer it was written
      // for, and job boards take their postings down.
      jobOffer: jobOffer ? String(jobOffer) : null,
      scoreAvant: typeof scoreAvant === 'number' ? scoreAvant : null,
      scoreApres: typeof scoreApres === 'number' ? scoreApres : null,
      interviewDate: null,
      status: 'envoyee',
      date: new Date().toISOString().slice(0, 10),
      createdAt: new Date().toISOString(),
    };

    const list = readApplications();
    list.unshift(entry); // most recent first — that's what the tracking tab shows top-down
    await atomicWriteJson(applicationsPath, list);
    return entry;
  }

  /**
   * Moves a tracked application to "refusee" or "acceptee" (or back to
   * "envoyee"), and/or sets or clears its interview date. Either field may
   * be omitted — one PATCH covering both small edits the tracking tab
   * makes, not two near-identical endpoints.
   */
  async function updateApplication(id, { status, interviewDate } = {}) {
    if (status !== undefined && !STATUSES.includes(status)) {
      const err = new Error(`Statut invalide : "${status}". Attendu : ${STATUSES.join(', ')}.`);
      err.status = 400;
      throw err;
    }
    if (interviewDate !== undefined && interviewDate !== null && !/^\d{4}-\d{2}-\d{2}$/.test(interviewDate)) {
      const err = new Error('"interviewDate" doit être au format AAAA-MM-JJ, ou null.');
      err.status = 400;
      throw err;
    }

    const list = readApplications();
    const entry = list.find((a) => a.id === id);
    if (!entry) {
      const err = new Error('Candidature introuvable.');
      err.status = 404;
      throw err;
    }

    if (status !== undefined) entry.status = status;
    if (interviewDate !== undefined) entry.interviewDate = interviewDate;
    entry.updatedAt = new Date().toISOString();
    await atomicWriteJson(applicationsPath, list);
    return entry;
  }

  return { readApplications, addApplication, updateApplication };
}

module.exports = { STATUSES, createApplicationsStore };
