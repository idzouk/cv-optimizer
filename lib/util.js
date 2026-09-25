'use strict';

const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

/**
 * Writes JSON to a temp file in the same directory, then renames it into
 * place. A rename on the same filesystem is atomic — a crash mid-write, or
 * a concurrent read, sees the old file whole or the new one whole, never a
 * half-written one.
 */
async function atomicWriteJson(filePath, data) {
  const dir = path.dirname(filePath);
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  const content = JSON.stringify(data, null, 2) + '\n';

  await fsp.writeFile(tmpPath, content, 'utf8');
  try {
    await fsp.rename(tmpPath, filePath);
  } catch (err) {
    await fsp.unlink(tmpPath).catch(() => {});
    throw err;
  }
}

/**
 * Filename-safe slug: accents stripped, special characters dropped,
 * spaces → "_". Word casing is preserved so acronyms survive
 * ("Chef de Projet IA" → "Chef_de_Projet_IA").
 */
function slugify(value, fallback = 'Poste') {
  const slug = String(value || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip accents
    .replace(/['’]/g, ' ')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .join('_');
  return slug || fallback;
}

function todayStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Remove ```json fences (and any stray prose) before JSON.parse. */
function stripFences(text) {
  let t = String(text || '').trim();
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) t = fenced[1].trim();
  if (!t.startsWith('{') && !t.startsWith('[')) {
    const first = t.search(/[[{]/);
    const lastObj = t.lastIndexOf('}');
    const lastArr = t.lastIndexOf(']');
    const last = Math.max(lastObj, lastArr);
    if (first !== -1 && last > first) t = t.slice(first, last + 1);
  }
  return t.trim();
}

/**
 * How many pages the rendered PDF actually has.
 *
 * The fitting logic measures the DOM; this measures the artefact that
 * comes out of it, which is the only number that settles whether the CV
 * is on one page. Puppeteer writes an uncompressed page tree, so counting
 * the page objects is enough — `/Type /Pages` (the parent node) is
 * excluded by requiring a non-"s" character after "Page".
 *
 * Returns null when the structure isn't recognisable, so callers can tell
 * "two pages" from "could not tell".
 */
function pdfPageCount(buffer) {
  const matches = Buffer.from(buffer).toString('latin1').match(/\/Type\s*\/Page[^s]/g);
  return matches ? matches.length : null;
}

module.exports = { atomicWriteJson, slugify, todayStamp, escapeHtml, stripFences, pdfPageCount };
