// The checker. Nothing a model writes gets onto the map until this passes.
//
// Two jobs:
//   1. Refuse any write-up that names a file, function or table that is not
//      really in the repo. An invented box must never look like a real one.
//   2. Refuse jargon. The word list and its plain replacements are lifted
//      from the prototype-map skill, which is where these rules were settled.

import fs from 'node:fs';
import path from 'node:path';

// Left side is what not to write. Right side is what to write instead, so the
// complaint tells you how to fix it.
const BANNED = {
  idempotency: 'repeat delivery',
  idempotent: 'safe to repeat',
  normalize: 'tidy up',
  normalise: 'tidy up',
  decompose: 'break apart',
  payload: 'the data sent',
  provenance: 'where it came from',
  entity: 'thing',
  orchestrate: 'run in order',
  hydrate: 'load',
  persist: 'save',
  cardinality: 'how many',
  schema: 'shape',
};

// "hydrates", "persisted", "orchestrating" are the same offence as the stem.
// The skill's own version of this misses "entities" and "cardinalities"; this
// one does not.
const BANNED_RE = Object.fromEntries(
  Object.keys(BANNED).map(w => [
    w,
    new RegExp(`\\b${w}(?:s|es|d|ed|ing|ion|ions|ies)?\\b`, 'i'),
  ])
);

const PROSE_FIELDS = [
  ['whatItDoes', 'sentences', 3],
  ['observed', 'sentences', 1],
  ['dataIn', 'bullets', 8],
  ['dataOut', 'bullets', 8],
  ['manipulation', 'bullets', 8],
];

export function bannedHits(text) {
  const out = [];
  for (const [word, re] of Object.entries(BANNED_RE)) {
    if (re.test(String(text))) out.push({ word, instead: BANNED[word] });
  }
  return out;
}

/**
 * An index of every name that really exists, built once from the shape layer
 * plus the files on disk. Checking a claim is then a lookup, not a search.
 */
export function buildIndex(graph) {
  const symbols = new Map();   // lowercase bare name -> [{file, line, label}]
  const files = new Set();
  const dirs = new Set();

  for (const n of graph.nodes) {
    files.add(n.source_file);
    const parts = n.source_file.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
    const bare = bareName(n.label);
    if (!bare) continue;
    if (!symbols.has(bare)) symbols.set(bare, []);
    symbols.get(bare).push({
      file: n.source_file,
      line: lineOf(n.source_location),
      label: n.label,
      id: n.id,
    });
  }
  return { symbols, files, dirs, repoRoot: graph.repoRoot };
}

// "createDraft()" -> "createdraft"; ".render()" -> "render"; "POST /api/x" -> "post /api/x"
function bareName(label) {
  let s = String(label || '').trim();
  if (!s) return '';
  if (/^(GET|POST|PUT|PATCH|DELETE)\s/i.test(s)) return s.toLowerCase();
  s = s.replace(/\(.*\)$/, '').replace(/^\./, '');
  s = s.split('.').pop();
  return s.toLowerCase();
}

function lineOf(loc) {
  const m = /^L(\d+)/.exec(loc || '');
  return m ? Number(m[1]) : null;
}

/**
 * Check one claim — a function name, a file path, a table name. Returns
 * {ok, what, where} so the page can show a tick or a cross against each one.
 */
export function checkClaim(index, claim, kind = 'symbol') {
  const raw = String(claim || '').trim();
  if (!raw) return { ok: false, what: claim, why: 'empty' };

  // A claim written as a path is checked as a path.
  if (raw.includes('/') && !/^\w+\s/.test(raw)) {
    const rel = raw.replace(/^\.?\//, '').split(':')[0];
    if (index.files.has(rel) || index.dirs.has(rel)) return { ok: true, what: raw, where: rel };
    const hit = [...index.files].find(f => f.endsWith('/' + rel) || f === rel);
    if (hit) return { ok: true, what: raw, where: hit };
    if (fs.existsSync(path.join(index.repoRoot, rel))) return { ok: true, what: raw, where: rel };
    return { ok: false, what: raw, why: 'no such file in this repo' };
  }

  // A table name: look for it in the database files rather than the code index.
  if (kind === 'table') {
    const hit = grepTable(index, raw);
    return hit
      ? { ok: true, what: raw, where: hit }
      : { ok: false, what: raw, why: 'no table by that name' };
  }

  const bare = bareName(raw);
  const hits = index.symbols.get(bare);
  if (hits && hits.length) {
    return { ok: true, what: raw, where: `${hits[0].file}:${hits[0].line}`, count: hits.length };
  }
  return { ok: false, what: raw, why: 'nowhere in the repo — fix the name, or mark the box planned' };
}

// Tables are not in the code index, so look in the migration and type files
// once and remember what was found.
let tableCache = null;
function grepTable(index, name) {
  if (!tableCache) {
    tableCache = new Map();
    const roots = ['supabase', 'db', 'migrations', 'prisma'];
    for (const r of roots) {
      const dir = path.join(index.repoRoot, r);
      if (!fs.existsSync(dir)) continue;
      walk(dir, 3, file => {
        if (!/\.(sql|ts|prisma)$/.test(file)) return;
        let text;
        try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
        // Postgres quotes each part on its own — create table "public"."documents"
        // — so the name has to be read through the quotes, not up to the first one.
        const re = /create\s+table\s+(?:if\s+not\s+exists\s+)?((?:["'`]?\w+["'`]?\s*\.\s*)*["'`]?\w+["'`]?)/gi;
        let m;
        while ((m = re.exec(text))) {
          const t = m[1].replace(/["'`\s]/g, '').split('.').pop().toLowerCase();
          if (t && !tableCache.has(t)) tableCache.set(t, path.relative(index.repoRoot, file));
        }
      });
    }
  }
  const bare = String(name).replace(/\s*\(.*\)$/, '').split('.').pop().toLowerCase();
  return tableCache.get(bare) || null;
}

function walk(dir, depth, fn) {
  if (depth < 0) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, depth - 1, fn);
    else fn(full);
  }
}

/**
 * Check a whole write-up. Returns the write-up with a `checked` list attached,
 * plus `rejected` when something is wrong enough that it must not be shown.
 */
export function checkMeaning(index, meaning) {
  const checked = [];
  const problems = [];

  for (const name of meaning.functionsCalled || []) {
    checked.push(withLabel(checkClaim(index, name), `calls ${name}`));
  }
  for (const name of meaning.tablesTouched || []) {
    checked.push(withLabel(checkClaim(index, name, 'table'), `table ${name}`));
  }
  for (const name of meaning.runsAs || []) {
    checked.push(withLabel(checkClaim(index, name), name));
  }

  for (const c of checked) if (!c.ok) problems.push(`${c.what}: ${c.why}`);

  // Plain words.
  for (const [field, kind, cap] of PROSE_FIELDS) {
    const value = meaning[field];
    if (!value) continue;
    const texts = Array.isArray(value) ? value : [value];
    for (const t of texts) {
      for (const hit of bannedHits(t)) {
        problems.push(`"${hit.word}" in ${field} — write "${hit.instead}" instead`);
      }
    }
    if (kind === 'bullets' && Array.isArray(value) && value.length > cap) {
      problems.push(`${field} has ${value.length} points; keep it to ${cap}`);
    }
    if (kind === 'sentences' && typeof value === 'string') {
      const n = value.split(/[.!?]+\s/).filter(s => s.trim()).length;
      if (n > cap) problems.push(`${field} is ${n} sentences; keep it to ${cap}`);
    }
  }

  return { ...meaning, checked, problems };
}

function withLabel(result, what) {
  return { ok: result.ok, what, where: result.where || null, why: result.why || null };
}
