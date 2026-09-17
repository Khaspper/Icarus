// The first look at a repo nobody has mapped yet.
//
// Two halves, and the split between them is the point:
//
//   surfaceEvidence()  free. Folder and file NAMES, the biggest source files,
//                      what each package calls itself, the top of the README.
//                      It opens four kinds of thing and nothing else.
//   proposeParts()     one model call on that listing, and it comes back with
//                      the handful of names a person actually says out loud —
//                      Personas, MoBlogs, MoMail, RAG. No amount of free
//                      reading produces those, because they are nowhere in the
//                      code.
//
// What comes back is a proposal, not the map. The person picks, and every name
// they pick is written out bare: a name and nothing else, claiming nothing,
// because at that point nobody has read a line of that part yet.

import fs from 'node:fs';
import path from 'node:path';

import { ask, WORD_RULES_TEXT } from './agent.mjs';
import { bareNode, writeNode, resolve, slugSegment } from './nodes.mjs';

// Backend only, and it is a list of things to skip rather than a list of
// folders to keep — naming the backend folders by hand is wrong the moment
// somebody adds another one.
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'graphify-out', '.scratch', 'scratch', 'dist',
  'build', '.next', 'coverage', 'public', 'components', 'styles', 'assets',
  'docs', 'test', 'tests', '__tests__', '.map', '.graph-ide',
  'snippets',
]);

// graphify-* is a family of folders, not one name.
const SKIP_DIR_RE = /^graphify-/;

const SKIP_EXT = new Set([
  '.tsx', '.jsx', '.css', '.scss', '.svg', '.png', '.jpg', '.gif', '.ico', '.lock',
]);

// The biggest file in a repo is usually a lock file, a data dump or generated
// types, and none of those say a word about what the product does. So the size
// ranking only considers files somebody wrote by hand in a backend language.
const SOURCE_EXT = new Set([
  '.ts', '.mts', '.cts', '.js', '.mjs', '.cjs', '.py', '.go', '.rs', '.rb',
  '.java', '.kt', '.php', '.cs', '.swift', '.scala', '.ex', '.exs', '.sql',
  '.prisma', '.graphql', '.gql', '.proto',
]);
const GENERATED_RE = /\.(?:d\.ts|min\.js)$/i;

// Guards, so a repo nobody warned us about cannot make the free half crawl.
// The walk is breadth-first, so when a cap does bite it bites on the deepest,
// least telling corner of the tree and the shallow folders are already in.
const MAX_DEPTH = 6;
const MAX_ENTRIES = 20000;
const FOLDER_DEPTH = 2;
const MAX_FOLDERS = 200;
const MAX_PACKAGES = 24;
const MAX_SCRIPTS = 20;
const BIG_FILES = 40;
const README_LINES = 15;

const README_RE = /^readme(?:\.(?:md|markdown|txt))?$/i;

/**
 * What can be known about a repo for nothing: folder names, file names and
 * sizes, and the only two kinds of file worth opening before anyone has asked
 * for anything — every package.json, and the top of the README. The contents
 * of nothing else are read.
 */
export function surfaceEvidence(repoRoot) {
  const folders = [];
  const packages = [];
  const candidates = [];
  let topReadme = [];
  let seen = 0;

  const queue = [{ rel: '', depth: 0 }];
  while (queue.length) {
    const { rel, depth } = queue.shift();
    let entries;
    try { entries = fs.readdirSync(path.join(repoRoot, rel), { withFileTypes: true }); }
    catch { continue; }

    for (const entry of entries) {
      if (++seen > MAX_ENTRIES) { queue.length = 0; break; }
      const name = entry.name;
      const here = rel ? `${rel}/${name}` : name;

      // isDirectory() is false for a symlink, so a link into node_modules or
      // back up the tree is simply never followed.
      if (entry.isDirectory()) {
        if (skipDir(name)) continue;
        if (depth < FOLDER_DEPTH && folders.length < MAX_FOLDERS) folders.push(here);
        if (depth + 1 < MAX_DEPTH) queue.push({ rel: here, depth: depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;

      if (name === 'package.json') {
        if (packages.length < MAX_PACKAGES) {
          const pkg = readPackage(repoRoot, here);
          if (pkg) packages.push(pkg);
        }
        continue;
      }
      if (!rel && README_RE.test(name) && !topReadme.length) {
        topReadme = readTop(repoRoot, here);
        continue;
      }

      const ext = extOf(name);
      if (SKIP_EXT.has(ext) || !SOURCE_EXT.has(ext) || GENERATED_RE.test(name)) continue;
      let bytes;
      try { bytes = fs.statSync(path.join(repoRoot, here)).size; } catch { continue; }
      candidates.push({ path: here, bytes });
    }
  }

  candidates.sort((a, b) => b.bytes - a.bytes);
  return { folders, bigFiles: candidates.slice(0, BIG_FILES), packages, topReadme };
}

function skipDir(name) {
  // Every dot-folder is somebody's tooling, never a part of the product.
  return SKIP_DIRS.has(name) || SKIP_DIR_RE.test(name) || name.startsWith('.');
}

function extOf(name) {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i).toLowerCase();
}

function readPackage(repoRoot, rel) {
  let pkg;
  try { pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, rel), 'utf8')); }
  catch { return null; }
  // The script names alone say what this package is for — the commands behind
  // them are long and say nothing a name does not.
  const scripts = Object.keys((pkg && pkg.scripts) || {}).slice(0, MAX_SCRIPTS);
  const folder = path.posix.dirname(rel);
  return {
    path: rel,
    name: String((pkg && pkg.name) || '').trim() || (folder === '.' ? 'the repo root' : folder),
    scripts,
  };
}

function readTop(repoRoot, rel) {
  try {
    return fs.readFileSync(path.join(repoRoot, rel), 'utf8')
      .split('\n', README_LINES + 1)
      .slice(0, README_LINES)
      .map(line => line.replace(/\s+$/, ''));
  } catch { return []; }
}

// --- the one model call ----------------------------------------------------

const PARTS_SCHEMA = {
  type: 'object',
  properties: {
    parts: {
      type: 'array',
      description: 'between four and ten big parts of the product',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'what a person calls it out loud, one or two words' },
          why: { type: 'string', description: 'one plain sentence saying what it does for whoever uses the product' },
          seenIn: {
            type: 'array',
            items: { type: 'string' },
            description: 'the folders or files from the listing that made you say that name, up to 5',
          },
        },
        required: ['name', 'why', 'seenIn'],
      },
    },
  },
  required: ['parts'],
};

/**
 * One call, and the only one the map spends before anybody has asked for
 * anything. It gets the free listing and may open a few of the biggest files
 * to check itself, so the names it proposes are answerable.
 */
export async function proposeParts({ repoRoot, evidence, model = 'sonnet' }) {
  const seen = evidence || surfaceEvidence(repoRoot);

  const prompt = `Nobody has mapped this repo yet. Name the big parts of the product in it.

Name what the product DOES, the way the people who work on it say it out loud:
Personas, MoBlogs, MoMail, RAG. Not folder names, not file names, not layers —
"handlers", "services" and "shared" are not parts of a product, they are places
code was put.

Give between four and ten of them. Each one:
  name    what it is called out loud, one or two words
  why     one sentence, what it does for whoever uses the product
  seenIn  the folders or files below that made you say that name

Every part must point at something in this listing. Open a few of the biggest
files first if you are not sure — you can read, and guessing is the one thing
that ruins this. A name you cannot point at is worse than a name you left out,
so leave it out.

${describe(seen)}

${WORD_RULES_TEXT}`;

  const { out, cost } = await ask({
    repoRoot,
    prompt,
    schema: PARTS_SCHEMA,
    model,
    budget: '0.60',
    tools: ['Read', 'Grep', 'Glob'],
  });

  return { parts: cleanParts(out, seen), cost };
}

// Paths belong in this prompt: it is the evidence, not the map. None of it
// reaches a node — an accepted part is written as a name and nothing else.
function describe(evidence) {
  const lines = [];
  const { folders = [], bigFiles = [], packages = [], topReadme = [] } = evidence || {};

  if (folders.length) {
    lines.push('Folders, down to two levels:');
    for (const f of folders) lines.push('  ' + f);
  }
  if (bigFiles.length) {
    lines.push('', 'The biggest source files:');
    for (const f of bigFiles) lines.push(`  ${f.path}  (${Math.max(1, Math.round(f.bytes / 1024))}k)`);
  }
  if (packages.length) {
    lines.push('', 'Packages:');
    for (const p of packages) {
      const runs = p.scripts && p.scripts.length ? ` — runs ${p.scripts.join(', ')}` : '';
      lines.push(`  ${p.path}  "${p.name}"${runs}`);
    }
  }
  if (topReadme.length) {
    lines.push('', 'The top of the README:');
    for (const line of topReadme) lines.push('  ' + line);
  }
  return lines.join('\n');
}

/**
 * Hold the answer to what it was told: a real spoken name, one sentence, and
 * at least one honest pointer back into the listing. A proposal that points at
 * a folder this repo does not have is the one failure that would poison the
 * map from its very first node, so it is dropped rather than shown.
 */
function cleanParts(out, evidence) {
  const raw = Array.isArray(out) ? out : (out && out.parts) || [];
  const places = knownPlaces(evidence);
  const parts = [];
  const taken = new Set();

  for (const item of raw) {
    const name = String((item && item.name) || '').trim();
    if (!name || looksLikeAPath(name) || name.length > 40) continue;

    const slug = slugSegment(name);
    if (taken.has(slug)) continue;

    const seenIn = [...new Set((item.seenIn || []).map(tidy).filter(Boolean))].slice(0, 5);
    if (!seenIn.some(ref => places.some(p => under(p, ref) || under(ref, p)))) continue;

    taken.add(slug);
    parts.push({ name, why: String(item.why || '').trim(), seenIn });
    if (parts.length === 10) break;
  }
  return parts;
}

function knownPlaces(evidence) {
  const { folders = [], bigFiles = [], packages = [], topReadme = [] } = evidence || {};
  const places = new Set();
  for (const f of folders) places.add(tidy(f));
  for (const f of bigFiles) places.add(tidy(f.path));
  for (const p of packages) {
    if (p.path) places.add(tidy(p.path));
    if (p.name) places.add(tidy(p.name));
  }
  if (topReadme.length) { places.add('readme'); places.add('readme.md'); }
  places.delete('');
  return [...places];
}

function tidy(ref) {
  return String(ref || '')
    .trim()
    .toLowerCase()
    .replace(/\/\*+.*$/, '')   // a glob points at the folder above it
    .replace(/^\.?\/+/, '')
    .replace(/\/+$/, '');
}

// Only at a segment boundary, so "billing/db" cannot pass on the strength of
// some other folder called db.
function under(a, b) {
  return a === b || a.startsWith(b + '/');
}

function looksLikeAPath(name) {
  return name.includes('/') || /\.\w{1,5}$/.test(name);
}

// --- what the person picked ------------------------------------------------

/**
 * Write the accepted names out, each as a bare node: stated, not built. It
 * claims nothing, and it still counts, because everyone else can now point an
 * arrow at it.
 *
 * A name that is already on the map is left alone, and a name merely close to
 * one that is already there is left for a person to settle — quietly making a
 * second RAG splits the map in half and nobody notices until it is too late to
 * fix cheaply.
 */
export function acceptParts(repoRoot, names) {
  const created = [];
  const skipped = [];

  // A name on its own, or the whole proposed part, because both are what a
  // caller has in hand at this point.
  for (const entry of names || []) {
    const name = String(typeof entry === 'string' ? entry : (entry && entry.name) || '').trim();
    if (!name) continue;

    const found = resolve(repoRoot, null, name);
    if (found.kind === 'exact') {
      skipped.push({ name, key: found.key, why: 'already on the map' });
      continue;
    }
    if (found.kind === 'ambiguous') {
      skipped.push({
        name,
        key: null,
        why: `too close to ${found.candidates.map(c => c.name).join(', ')} — say which one was meant`,
        candidates: found.candidates,
      });
      continue;
    }

    const node = writeNode(repoRoot, bareNode(name, null));
    created.push({ key: node.key, name: node.name });
  }

  return { created, skipped };
}
