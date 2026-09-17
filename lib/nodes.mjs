// The store. One small JSON file per node, in `.map/` inside the repo it
// describes, named for the node's path through the map.
//
// Listing that folder IS the lookup: what exists, what is inside RAG, what
// sits at the top. Every one of those costs the same whether the map holds
// thirty nodes or three thousand, because nothing here ever loads the whole
// map and nothing here calls a model.
//
// Two rules live here because nowhere else can enforce them: a node holds
// meaning only, never a path (validateNode), and a lookup that is not an exact
// hit stops and asks rather than quietly making a second node (resolve).

import fs from 'node:fs';
import path from 'node:path';

const FOLDER = '.map';

// Segments are letters and digits only, joined by `-`, because `-` is what
// separates a node from its parent. A segment containing one would split the
// node onto a level it does not belong to.
const KEY_RE = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/;

const STATES = new Set(['named', 'read', 'planned']);

// Written in this order so a committed diff reads top-down, meaning first.
const FIELD_ORDER = [
  'key', 'name', 'state', 'title', 'type', 'status', 'summary', 'details',
  'edges', 'watches', 'checked', 'createdAt', 'readAt', 'readAtCommit',
];

export function mapDir(repoRoot) {
  return path.join(repoRoot, FOLDER);
}

// --- keys ------------------------------------------------------------------

/**
 * A name a person said, turned into one segment of a key. Letters and digits
 * survive, everything else is a word break, and the result never contains a
 * `-`. An all-capitals word goes fully lowercase, so RAG is `rag` and not
 * `rAG`; anything else keeps the humps it came with, so MoBlogs is `moBlogs`.
 */
// A segment is a filename, so it has a ceiling. Anything longer was a sentence
// somebody put in the name field, and the sentence belongs in the write-up.
const SEGMENT_MAX = 28;

export function slugSegment(name) {
  const words = String(name ?? '').match(/[A-Za-z0-9]+/g) || [];
  // A name with nothing spellable in it still needs a home to be written to.
  if (!words.length) return 'node';
  const slug = words
    .map(w => (/[A-Z]/.test(w) && !/[a-z]/.test(w) ? w.toLowerCase() : w))
    .map((w, i) => (i === 0
      ? w.charAt(0).toLowerCase() + w.slice(1)
      : w.charAt(0).toUpperCase() + w.slice(1)))
    .join('');
  if (slug.length <= SEGMENT_MAX) return slug;
  // Cut on a word boundary so what is left still reads as words.
  let cut = slug.slice(0, SEGMENT_MAX);
  const back = cut.search(/[A-Z][^A-Z]*$/);
  if (back > 8) cut = cut.slice(0, back);
  return cut;
}

export function keyFor(names) {
  const list = Array.isArray(names) ? names : [names];
  return list
    .filter(n => String(n ?? '').trim())
    .map(slugSegment)
    .join('-');
}

export function segmentsOf(key) {
  return String(key || '').split('-').filter(Boolean);
}

export function parentOf(key) {
  const segments = segmentsOf(key);
  return segments.length > 1 ? segments.slice(0, -1).join('-') : null;
}

function lastSegment(key) {
  const segments = segmentsOf(key);
  return segments[segments.length - 1] || '';
}

// A key arrives from a query string, so it is never trusted as a file name.
function fileFor(repoRoot, key) {
  const k = String(key || '');
  if (!KEY_RE.test(k)) throw new Error(`not a node key: ${JSON.stringify(key)}`);
  return path.join(mapDir(repoRoot), k + '.json');
}

// The reading side asks a question, so a key that cannot exist is simply not
// there rather than an error.
function keyPath(repoRoot, key) {
  const k = String(key || '');
  return KEY_RE.test(k) ? path.join(mapDir(repoRoot), k + '.json') : null;
}

// --- the listing, which is the whole lookup --------------------------------

export function listKeys(repoRoot) {
  let entries;
  try { entries = fs.readdirSync(mapDir(repoRoot)); } catch { return []; }
  return entries
    .filter(n => n.endsWith('.json'))
    .map(n => n.slice(0, -'.json'.length))
    .filter(k => KEY_RE.test(k))
    .sort();
}

export function topLevelKeys(repoRoot) {
  return listKeys(repoRoot).filter(k => !k.includes('-'));
}

// Everything below works off one listing, so a level costs one readdir and
// opens no files at all.
function childrenIn(listing, key) {
  if (!key) return listing.filter(k => !k.includes('-'));
  const prefix = key + '-';
  return listing.filter(k => k.startsWith(prefix) && !k.slice(prefix.length).includes('-'));
}

export function childKeys(repoRoot, key) {
  return childrenIn(listKeys(repoRoot), key);
}

export function descendantKeys(repoRoot, key) {
  if (!key) return listKeys(repoRoot);
  const prefix = key + '-';
  return listKeys(repoRoot).filter(k => k.startsWith(prefix));
}

export function hasChildren(repoRoot, key) {
  return childKeys(repoRoot, key).length > 0;
}

export function isLeaf(repoRoot, key) {
  return !hasChildren(repoRoot, key);
}

export function exists(repoRoot, key) {
  const file = keyPath(repoRoot, key);
  return Boolean(file) && fs.existsSync(file);
}

// --- reading and writing one node ------------------------------------------

export function readNode(repoRoot, key) {
  const file = keyPath(repoRoot, key);
  if (!file) return null;
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (err) { if (err.code === 'ENOENT') return null; throw err; }
  try { return JSON.parse(text); }
  // Writes are atomic, so a half-written node cannot exist. Broken JSON means
  // somebody edited it by hand, and treating that as "missing" would let the
  // next lookup make a second node for the same thing.
  catch { throw new Error(`the node at ${key} is not readable JSON — fix it by hand`); }
}

export function readMany(repoRoot, keys) {
  const out = [];
  for (const key of keys || []) {
    const node = readNode(repoRoot, key);
    if (node) out.push(node);
  }
  return out;
}

/**
 * Whole and atomic: the node is written beside its home and then renamed over
 * it, so a reader never catches half a node. Refuses anything validateNode
 * complains about, because a node that lies is worse than no node.
 */
export function writeNode(repoRoot, node) {
  const whole = { ...node, key: String((node && node.key) || '') };
  const complaints = validateNode(whole, repoRoot);
  if (complaints.length) {
    throw new Error(`this node cannot go on the map:\n  ${complaints.join('\n  ')}`);
  }
  writeAtomic(fileFor(repoRoot, whole.key), JSON.stringify(ordered(whole), null, 2) + '\n');
  return whole;
}

export function updateNode(repoRoot, key, patch) {
  const node = readNode(repoRoot, key);
  if (!node) throw new Error(`nothing is at ${key} to change`);
  // The key is the node's home, so it is never moved by a patch. That is what
  // renameSubtree is for.
  return writeNode(repoRoot, { ...node, ...patch, key: node.key || key });
}

export function deleteNode(repoRoot, key) {
  const file = keyPath(repoRoot, key);
  if (!file || !fs.existsSync(file)) return false;
  fs.rmSync(file, { force: true });
  return true;
}

export function removeSubtree(repoRoot, key) {
  const gone = [];
  for (const k of [key, ...descendantKeys(repoRoot, key)]) {
    if (deleteNode(repoRoot, k)) gone.push(k);
  }
  return gone;
}

/**
 * Renaming is the one cost of naming files after the path through the map, and
 * it stays cheap: file renames, the `key` inside each renamed file, and the
 * arrows elsewhere that pointed at a renamed node. Nothing else is read and
 * nothing else in any file is touched — a file with no such arrow is not even
 * opened for writing.
 */
export function renameSubtree(repoRoot, oldKey, newKey) {
  const from = String(oldKey || '');
  const to = String(newKey || '');
  if (!KEY_RE.test(from)) throw new Error(`not a node key: ${JSON.stringify(oldKey)}`);
  if (!KEY_RE.test(to)) throw new Error(`not a node key: ${JSON.stringify(newKey)}`);
  if (from === to) return { renamed: [], retargeted: [] };

  const listing = listKeys(repoRoot);
  const moves = new Map();
  for (const k of listing) {
    if (k === from) moves.set(k, to);
    else if (k.startsWith(from + '-')) moves.set(k, to + k.slice(from.length));
  }
  if (!moves.size) return { renamed: [], retargeted: [] };

  const taken = new Set(listing);
  for (const dest of moves.values()) {
    if (taken.has(dest)) throw new Error(`there is already a node at ${dest}`);
  }

  const renamed = [];
  for (const [was, now] of moves) {
    const src = fileFor(repoRoot, was);
    const text = fs.readFileSync(src, 'utf8');
    writeAtomic(fileFor(repoRoot, now), retarget(text, moves, true));
    fs.rmSync(src, { force: true });
    renamed.push({ from: was, to: now });
  }

  const retargeted = [];
  for (const k of listing) {
    if (moves.has(k)) continue;
    const file = fileFor(repoRoot, k);
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const next = retarget(text, moves, false);
    if (next === text) continue;
    writeAtomic(file, next);
    retargeted.push(k);
  }

  return { renamed, retargeted };
}

// Swap only the value of an arrow's `to`, and of `key` in a file that moved.
// A parse-and-restore round trip would rewrite every other line of a file
// nobody touched, which is exactly what rule five forbids.
function retarget(text, moves, ownKey) {
  const fields = ownKey ? 'to|key' : 'to';
  let out = text;
  for (const [was, now] of moves) {
    const re = new RegExp(`("(?:${fields})"\\s*:\\s*")${escapeRe(was)}(")`, 'g');
    out = out.replace(re, `$1${now}$2`);
  }
  return out;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // The temp name does not end in .json, so a listing taken mid-write never
  // sees a node that is not there yet.
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  fs.writeFileSync(tmp, text);
  try { fs.renameSync(tmp, file); }
  catch (err) { fs.rmSync(tmp, { force: true }); throw err; }
}

function ordered(node) {
  const out = {};
  for (const f of FIELD_ORDER) if (node[f] !== undefined) out[f] = node[f];
  for (const [k, v] of Object.entries(node)) if (!(k in out)) out[k] = v;
  return out;
}

// --- making nodes ----------------------------------------------------------

/**
 * Stated, not built. A name and nothing else: it claims nothing, and it still
 * counts, because other people can point arrows at it.
 */
export function bareNode(name, parentKey) {
  const segment = slugSegment(name);
  return {
    key: parentKey ? `${parentKey}-${segment}` : segment,
    name: String(name ?? '').trim() || segment,
    state: 'named',
    createdAt: new Date().toISOString(),
  };
}

/**
 * Walk a path of names down from the top, making every missing one on the way
 * as a bare name. This is what lets "build RAG chunking" work when there is no
 * RAG node anywhere.
 */
export function ensurePath(repoRoot, names) {
  const keys = [];
  const created = [];
  let parent = null;
  for (const name of names || []) {
    if (!String(name ?? '').trim()) continue;
    const key = parent ? `${parent}-${slugSegment(name)}` : slugSegment(name);
    if (!exists(repoRoot, key)) {
      writeNode(repoRoot, bareNode(name, parent));
      created.push(key);
    }
    keys.push(key);
    parent = key;
  }
  return { keys, created };
}

/**
 * One name, one node. An exact slug hit is the node. Anything merely close
 * comes back as ambiguous and the caller must stop and ask which was meant —
 * quietly making a second node splits the map in half and nobody notices until
 * it is too late to fix cheaply.
 */
export function resolve(repoRoot, parentKey, name) {
  const slug = slugSegment(name);
  const siblings = childrenIn(listKeys(repoRoot), parentKey);
  const key = parentKey ? `${parentKey}-${slug}` : slug;

  if (siblings.includes(key)) return { kind: 'exact', key, candidates: [] };

  const near = siblings.filter(sib => isClose(slug, lastSegment(sib)));
  if (near.length) {
    return {
      kind: 'ambiguous',
      key: null,
      candidates: near.map(k => {
        const node = readNode(repoRoot, k);
        return { key: k, name: (node && node.name) || lastSegment(k) };
      }),
    };
  }
  return { kind: 'missing', key, candidates: [] };
}

// Close enough to be worth asking about: one contains the other, they share a
// real word, they are the same stem said two ways, or they are a few edits
// apart. Asking costs a question; guessing costs the map.
function isClose(a, b) {
  const x = String(a).toLowerCase();
  const y = String(b).toLowerCase();
  if (x === y) return true;
  if (x.includes(y) || y.includes(x)) return true;

  // A two-letter overlap is not a shared word. Without this floor, MoMail and
  // MoBlogs read as the same thing because they both start with "Mo".
  const words = new Set(wordsOf(x).filter(w => w.length >= 3));
  if (wordsOf(y).some(w => w.length >= 3 && words.has(w))) return true;

  // The same stem with a different ending: chunker against chunking, retrieve
  // against retrieval. The ending differs, the thing does not.
  const shorter = Math.min(x.length, y.length);
  const stem = sharedPrefix(x, y);
  if (stem >= 4 && stem / shorter >= 0.6) return true;

  // A long name can sit more than two edits from the same idea, so let the
  // slack grow with the length instead of fixing it at two.
  return editDistance(x, y) <= Math.max(2, Math.floor(shorter / 3));
}

function sharedPrefix(x, y) {
  let i = 0;
  while (i < x.length && i < y.length && x[i] === y[i]) i++;
  return i;
}

function wordsOf(slug) {
  return String(slug)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function editDistance(a, b) {
  if (a === b) return 0;
  if (!a.length || !b.length) return Math.max(a.length, b.length);
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(row[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = row;
  }
  return prev[b.length];
}

// --- what the canvas draws -------------------------------------------------

export function summarise(repoRoot, keys) {
  const listing = listKeys(repoRoot);
  const out = [];
  for (const key of keys || []) {
    const node = readNode(repoRoot, key);
    if (node) out.push(summaryOf(node, listing));
  }
  return out;
}

function summaryOf(node, listing) {
  return {
    key: node.key,
    name: node.name || lastSegment(node.key),
    title: node.title || '',
    state: STATES.has(node.state) ? node.state : 'named',
    type: node.type || null,
    status: node.status || null,
    runsAs: (node.details && node.details.runsAs) || [],
    // From the listing, so a whole level costs no extra reads.
    hasChildren: childrenIn(listing, node.key).length > 0,
    stale: Boolean(node.stale),
  };
}

/**
 * One level of the map: the nodes directly under `parentKey`, and the arrows
 * leaving them. Arrows live on the node they leave from, so this opens the
 * nodes on this level and nothing else. An arrow whose other end is somewhere
 * else still comes back, marked `offLevel`, so the canvas can draw it leaving
 * the picture instead of pretending it is not there.
 */
export function levelView(repoRoot, parentKey) {
  const listing = listKeys(repoRoot);
  const keys = childrenIn(listing, parentKey);
  const here = new Set(keys);
  const nodes = [];
  const edges = [];

  for (const key of keys) {
    const node = readNode(repoRoot, key);
    if (!node) continue;
    nodes.push(summaryOf(node, listing));
    for (const edge of node.edges || []) {
      if (!edge || !edge.to) continue;
      const arrow = {
        from: key,
        to: edge.to,
        label: edge.label || '',
        byHand: Boolean(edge.byHand),
      };
      // A note is the person's, so it travels with the arrow untouched.
      if (edge.note) arrow.note = edge.note;
      if (!here.has(edge.to)) arrow.offLevel = true;
      edges.push(arrow);
    }
  }
  return { nodes, edges };
}

// --- the two rules nothing else can enforce --------------------------------

// A `/` between word characters, or a known source extension. Both mean a
// location got into the meaning.
// A slash on its own is not a path. "read/write" and "and/or" are how people
// talk; "trigger/src" and "moflo-cloud/app" are where code lives. Telling them
// apart is the difference between refusing a path and throwing away an honest
// sentence over a turn of phrase.
const SLASHED_RE = /(?:^|[\s(,"'])([\w.@-]+(?:\/[\w.@-]+)+)(?=$|[\s).,;:"'])/g;
const CODE_WORD = new Set([
  'src', 'lib', 'app', 'apps', 'api', 'packages', 'components', 'pages', 'routes',
  'functions', 'migrations', 'scripts', 'types', 'utils', 'helpers', 'hooks',
  'server', 'client', 'public', 'dist', 'build', 'test', 'tests', 'spec', 'web',
  'node_modules', 'supabase', 'trigger', 'db', 'sql', 'config', 'assets',
  'styles', 'static', 'docs', 'bin', 'cmd', 'internal', 'pkg',
]);
const EXT_RE = /\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts|json|sql|py|go|rs|rb|java|php|css|scss|html|md|ya?ml|sh|toml|prisma|lock)\b/i;

// These are the names of things, not files, and a person says them out loud.
const PRODUCT_RE = /\b(?:node|next|nuxt|vue|three|d3)\.js\b/gi;

// A route is a real identifier a node runs as, the same way a function name
// is. It is allowed in runsAs and nowhere else.
const ROUTE_RE = /^(?:(?:GET|POST|PUT|PATCH|DELETE)\s+)?\/\S*$/i;

/**
 * What is wrong with this node, in plain words, so the complaint says how to
 * fix it. Empty means it can go on the map.
 *
 * `repoRoot` is optional: given one, the check that a node has exactly one
 * home is made against the real folder; without one, only the shape of the key
 * can be checked.
 */
export function validateNode(node, repoRoot) {
  if (!node || typeof node !== 'object') return ['a node must be an object'];
  const complaints = [];
  const key = String(node.key || '');

  if (!key) complaints.push('a node needs a key, which is its path through the map');
  else if (!KEY_RE.test(key)) {
    complaints.push(`"${key}" is not a key — segments are letters and digits joined by "-"`);
  } else {
    for (const segment of segmentsOf(key)) {
      const slug = slugSegment(segment);
      if (slug !== segment) complaints.push(`"${segment}" in the key should be "${slug}"`);
    }
  }

  if (!String(node.name || '').trim()) complaints.push('a node needs a name a person would say');
  if (node.state && !STATES.has(node.state)) {
    complaints.push(`"${node.state}" is not a state — named, read or planned`);
  }

  // Rule one: a node holds meaning only. Paths live in `watches`, and what a
  // node watches is not what a node means.
  for (const [where, text] of meaningStrings(node)) {
    const why = locationLike(text);
    if (why) complaints.push(`${where} ${why}: "${shorten(text)}" — meaning only, the path belongs in watches`);
  }

  // Rule two: exactly one home. Everything else is an arrow.
  if (repoRoot && KEY_RE.test(key)) {
    const parent = parentOf(key);
    if (parent && !exists(repoRoot, parent)) {
      complaints.push(`there is no node at ${parent}, so ${key} has nowhere to live`);
    }
  }

  return complaints;
}

function locationLike(text) {
  const s = String(text).replace(PRODUCT_RE, '');
  const run = readsAsPath(s);
  if (run) return `reads as a path (${run})`;
  const hit = EXT_RE.exec(s);
  return hit ? `reads as a file name (${hit[0]})` : null;
}

function readsAsPath(text) {
  SLASHED_RE.lastIndex = 0;
  let m;
  while ((m = SLASHED_RE.exec(text))) {
    const run = m[1];
    const parts = run.split('/');
    // Two levels can be a turn of phrase. Three is nobody's.
    if (parts.length > 2) return run;
    if (parts.some(p => CODE_WORD.has(p.toLowerCase()))) return run;
    // Kebab, snake, or a dot in a name: that is a folder, not a word.
    if (parts.some(p => /[-_.]/.test(p))) return run;
    if (parts.some(p => p.length > 12)) return run;
  }
  return null;
}

function* meaningStrings(node) {
  if (node.title) yield ['the title', node.title];
  if (node.summary) yield ['the summary', node.summary];
  yield* walkStrings(node.details, 'details');
}

function* walkStrings(value, where) {
  if (typeof value === 'string') {
    if (!(where.endsWith('runsAs') && ROUTE_RE.test(value.trim()))) yield [where, value];
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) yield* walkStrings(item, where);
    return;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) yield* walkStrings(v, `${where}.${k}`);
  }
}

function shorten(text) {
  const s = String(text).trim();
  return s.length > 70 ? s.slice(0, 67) + '…' : s;
}
