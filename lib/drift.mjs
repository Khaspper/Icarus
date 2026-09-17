// Which nodes watch which code, and what went stale.
//
// The rule this file exists to keep: a rebuild must never quietly reword
// something that was already right. So nothing in here writes meaning. The
// worst it ever does to a node is say "the ground under this moved, go and
// look" — and it only says that when it can point at the bytes that changed.
//
// A node is matched to its code by the function's NAME, never by its path.
// Code that moves folders is the same thing at a new address, so the write-up
// is kept and a pure move costs nothing.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { mapDir, listKeys, readNode, writeNode } from './nodes.mjs';

/**
 * Eight characters of a sha1 of the file's bytes. Null when the file is not
 * there, which is itself an answer: what this node was read from is gone.
 */
export function fingerprint(repoRoot, relPath) {
  try {
    const bytes = fs.readFileSync(path.join(repoRoot, norm(relPath)));
    return crypto.createHash('sha1').update(bytes).digest('hex').slice(0, 8);
  } catch {
    return null;
  }
}

// --- the watch index -------------------------------------------------------
//
// Derived, local, and never written into the repo it describes. It answers
// "this commit touched these four files, which nodes care?" without opening
// every node in the map. A file like this inside a shared repo would be edited
// by everyone and conflict on every pull — and it is worthless anyway, because
// it can be thrown away and rebuilt from the node files at any time.

// Keyed by repo path the same way server.mjs names its own state file, with a
// suffix so the two sit side by side in state/ without touching each other.
export function stateFileFor(stateDir, repoRoot) {
  return path.join(stateDir, safeName(path.resolve(repoRoot)) + '.watch.json');
}

export function buildWatchIndex(repoRoot, stateDir) {
  const nodes = {};
  const byFile = {};
  const byFunction = {};
  const stamp = {};

  for (const key of listKeys(repoRoot)) {
    stamp[key] = stampOf(repoRoot, key);
    const node = readNode(repoRoot, key);
    if (!node) continue;

    const w = node.watches || {};
    const files = uniq(w.files).map(norm);
    const functions = uniq(w.functions);
    nodes[key] = {
      name: node.name || key,
      state: node.state || 'named',
      files,
      functions,
      fingerprints: rekey(w.fingerprints),
      // Whether the node already carries an alarm, so a sweep knows without
      // opening it whether there is a false one left to clear. `moved` is not
      // an alarm — it is a note that the address was corrected, and clearing
      // it would cost a second write to a file that is committed and shared.
      marked: Boolean(node.stale || node.gone),
    };
    for (const f of files) (byFile[f] = byFile[f] || []).push(key);
    for (const fn of functions) {
      const b = bare(fn);
      if (b) (byFunction[b] = byFunction[b] || []).push(key);
    }
  }

  const index = {
    repoRoot: path.resolve(repoRoot),
    builtAt: new Date().toISOString(),
    stamp, nodes, byFile, byFunction,
  };
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(stateFileFor(stateDir, repoRoot), JSON.stringify(index, null, 2));
  } catch { /* derived: losing it costs a rebuild, nothing more */ }
  return index;
}

/** Which nodes care about these files. Opens no node at all. */
export function nodesWatching(repoRoot, stateDir, files) {
  const watch = watchIndex(repoRoot, stateDir);
  const out = new Set();
  for (const f of files || []) {
    for (const key of watch.byFile[norm(f)] || []) out.add(key);
  }
  return [...out].sort();
}

// The saved index is only trusted while the folder it was built from still
// looks the way it did. Anything else and it is rebuilt, because a wrong
// answer here means a commit silently misses the nodes it broke.
function watchIndex(repoRoot, stateDir) {
  let saved = null;
  try { saved = JSON.parse(fs.readFileSync(stateFileFor(stateDir, repoRoot), 'utf8')); } catch {}
  return fresh(repoRoot, saved) ? saved : buildWatchIndex(repoRoot, stateDir);
}

function fresh(repoRoot, saved) {
  if (!saved || !saved.stamp || !saved.nodes) return false;
  if (saved.repoRoot !== path.resolve(repoRoot)) return false;
  const keys = listKeys(repoRoot);
  if (keys.length !== Object.keys(saved.stamp).length) return false;
  for (const key of keys) {
    if (!(key in saved.stamp)) return false;
    if (stampOf(repoRoot, key) > saved.stamp[key]) return false;
  }
  return true;
}

// --- matching a node to its code ------------------------------------------

/**
 * Find the code this node watches, by name. `index` is what buildIndex() in
 * verify.mjs hands back: a map from a bare lowercase name to the places that
 * name is really defined.
 *
 * Returns what it found, and the watches the node would have if it took the
 * new addresses. It decides nothing about meaning:
 *
 *   gone   nothing it watches is anywhere in the repo any more
 *   moved  something it watches has left the address it was read from
 *   clean  every one of those moves is byte for byte the same file elsewhere,
 *          which is the case that must cost nothing
 */
export function relocate(repoRoot, node, index) {
  const w = (node && node.watches) || {};
  const functions = uniq(w.functions);
  const was = uniq(w.files).map(norm);
  const prints = rekey(w.fingerprints);

  const out = {
    gone: false, moved: false, clean: true,
    missing: [], from: [], to: [], moves: [],
    watches: { functions, files: was, fingerprints: prints },
    node,
  };

  // A node that names no function can only be matched by its files. Nothing to
  // relocate; the fingerprints decide on their own.
  if (!functions.length) return out;

  const symbols = (index && index.symbols) || new Map();
  const places = new Set();
  let found = 0;
  for (const fn of functions) {
    const hits = symbols.get(bare(fn));
    if (!hits || !hits.length) { out.missing.push(fn); continue; }
    found++;
    for (const h of hits) places.add(norm(h.file));
  }

  // Every name it was written from has left the repo. Somebody deleted the
  // code, not moved it. Say so; deleting the node is not this file's call.
  if (!found) { out.gone = true; return out; }

  const alive = was.filter(f => onDisk(repoRoot, f));
  const vanished = was.filter(f => !onDisk(repoRoot, f));
  const arrived = [...places].filter(f => !was.includes(f)).sort();

  const files = [...alive];
  const next = {};
  for (const f of alive) if (prints[f]) next[f] = prints[f];

  const taken = new Set();
  for (const old of vanished) {
    const had = prints[old] || null;
    // The same bytes at a new address. Carry the record across and the node
    // never notices it moved.
    const twin = had ? arrived.find(f => !taken.has(f) && fingerprint(repoRoot, f) === had) : null;
    if (!twin) { out.clean = false; continue; }
    taken.add(twin);
    out.moves.push({ from: old, to: twin });
    if (!files.includes(twin)) files.push(twin);
    next[twin] = had;
  }

  out.moved = vanished.length > 0;
  out.from = vanished;
  out.to = arrived;
  out.watches = { functions, files: files.sort(), fingerprints: next };
  if (out.moved && out.clean) out.node = { ...node, watches: out.watches, moved: true };
  return out;
}

// --- what went stale -------------------------------------------------------

const WHY = {
  moved: 'the same code, at a new address',
  stale: 'the code under this changed — read it again to be sure of what it says',
  gone: 'the code this was written from is not in the repo any more',
};

/** Read-only. What would a rebuild have something to say about? */
export function staleNodes(repoRoot, stateDir, index) {
  const swept = sweep(repoRoot, stateDir, index, false);
  return [...swept.gone, ...swept.stale, ...swept.moved].sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Rule five: nothing is ever rewritten that nobody touched.
 *
 * A node whose watched files all still fingerprint the same is untouched and
 * its file is not opened for writing at all. A node whose code only moved gets
 * its addresses corrected and not one word of its meaning. A node whose code
 * really changed is marked, and nothing else about it changes — the words stay
 * exactly as they were until a person asks for them to be read again.
 */
export function rebuild(repoRoot, stateDir, index) {
  const swept = sweep(repoRoot, stateDir, index, true);
  // The node files this just wrote are what the watch index is derived from.
  if (swept.wrote) buildWatchIndex(repoRoot, stateDir);
  return { untouched: swept.untouched, moved: swept.moved, stale: swept.stale, gone: swept.gone };
}

function sweep(repoRoot, stateDir, index, write) {
  const watch = watchIndex(repoRoot, stateDir);
  const untouched = [], moved = [], stale = [], gone = [];
  let wrote = 0;

  for (const [key, e] of Object.entries(watch.nodes)) {
    const at = { key, name: e.name };

    // A plan watches code that does not exist yet, and a name on its own
    // watches nothing. Neither can go stale.
    if (e.state === 'planned' || (!e.files.length && !e.functions.length)) {
      if (e.marked && write) wrote += mark(repoRoot, key, clear());
      untouched.push(at);
      continue;
    }

    const r = relocate(repoRoot, { key, name: e.name, watches: e }, index);
    const explained = new Set(r.moves.map(m => m.from));

    const changed = [];
    for (const f of e.files) {
      if (explained.has(f)) continue;
      if (!onDisk(repoRoot, f)) { changed.push(f); continue; }
      const had = e.fingerprints[f];
      if (had && fingerprint(repoRoot, f) !== had) changed.push(f);
    }

    if (r.gone) {
      if (write) wrote += mark(repoRoot, key, {
        gone: true, stale: true,
        drift: drift({ changed: [], missing: r.missing, movedFrom: r.from, movedTo: r.to }),
      });
      gone.push({ ...at, kind: 'gone', why: WHY.gone, missing: r.missing, kept: true });
      continue;
    }

    // Anything that moved but is not the same bytes, or a name that has left
    // the repo, is a change of meaning until somebody reads it again.
    if (changed.length || r.missing.length || (r.moved && !r.clean)) {
      if (write) wrote += mark(repoRoot, key, {
        stale: true,
        drift: drift({ changed, missing: r.missing, movedFrom: r.from, movedTo: r.to }),
      });
      stale.push({ ...at, kind: 'stale', why: WHY.stale, changed, missing: r.missing, movedTo: r.to });
      continue;
    }

    if (r.moved) {
      if (write) wrote += mark(repoRoot, key, {
        watches: r.watches, moved: true, stale: false, gone: false,
        drift: drift({ changed: [], missing: [], movedFrom: r.from, movedTo: r.to }),
      });
      moved.push({ ...at, kind: 'moved', why: WHY.moved, from: r.from, to: r.to });
      continue;
    }

    // Nothing to say. The one case that must never open the file.
    if (e.marked && write) { wrote += mark(repoRoot, key, clear()); at.cleared = true; }
    untouched.push(at);
  }

  return { untouched, moved, stale, gone, wrote };
}

// A mark the ground is back under: the code fingerprints the way the node
// remembers it, so an older warning is now a lie and goes.
function clear() {
  return { stale: false, moved: false, gone: false, drift: null };
}

function drift(d) {
  return {
    changed: [...d.changed].sort(),
    missing: [...d.missing].sort(),
    movedFrom: [...d.movedFrom].sort(),
    movedTo: [...d.movedTo].sort(),
  };
}

// Write the mark only when it says something the node does not already say.
// The map is committed, so a rebuild that rewrote every node with a new
// timestamp would show up as a change to every file on every pull.
function mark(repoRoot, key, patch) {
  const node = readNode(repoRoot, key);
  if (!node) return 0;

  const next = { ...node, ...patch };
  if (next.drift && node.drift && same(strip(next.drift), strip(node.drift))) {
    next.drift = node.drift;           // same complaint, keep the hour it was first made
  } else if (next.drift) {
    next.drift = { ...next.drift, at: new Date().toISOString() };
  } else {
    delete next.drift;
  }
  if (!patch.stale) delete next.stale;
  if (!patch.moved) delete next.moved;
  if (!patch.gone) delete next.gone;

  if (same(next, node)) return 0;
  writeNode(repoRoot, next);
  return 1;
}

function strip(d) {
  const { at, ...rest } = d || {};
  return rest;
}

// --- small things ----------------------------------------------------------

function onDisk(repoRoot, rel) {
  try { return fs.statSync(path.join(repoRoot, rel)).isFile(); } catch { return false; }
}

function stampOf(repoRoot, key) {
  try { return fs.statSync(path.join(mapDir(repoRoot), key + '.json')).mtimeMs; } catch { return 0; }
}

function norm(rel) {
  return String(rel || '').trim().replace(/^\.\/+/, '').replace(/^\/+/, '');
}

function rekey(prints) {
  const out = {};
  for (const [k, v] of Object.entries(prints || {})) {
    const f = norm(k);
    if (f && v) out[f] = v;
  }
  return out;
}

function uniq(list) {
  const out = [];
  for (const x of list || []) {
    const s = String(x == null ? '' : x).trim();
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

// The shape verify.mjs keys its index by. A lookup only works while both sides
// spell the name the same way, so this has to stay a copy of that one.
function bare(label) {
  let s = String(label || '').trim();
  if (!s) return '';
  if (/^(GET|POST|PUT|PATCH|DELETE)\s/i.test(s)) return s.toLowerCase();
  s = s.replace(/\(.*\)$/, '').replace(/^\./, '');
  s = s.split('.').pop();
  return s.toLowerCase();
}

function same(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every(k => k in b && same(a[k], b[k]));
}

function safeName(s) { return String(s).replace(/[^\w.-]+/g, '_').slice(0, 120); }
