#!/usr/bin/env node
// A small local service behind the canvas. No dependencies.
//
//   node server.mjs <path-to-repo> [--port 4111]
//
// It serves the page, answers what to draw, runs the agent, and holds the
// honesty loop: after a change lands, read the code back and see whether it
// matches the box that asked for it.
//
// It also serves the node map: the meaning layer, one file per node in `.map/`
// inside the repo being described. The structural read below is where code
// lives; the map is what it means. They are deliberately not the same thing.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, execFile } from 'node:child_process';

import { loadGraph, view, rollup } from './lib/graph.mjs';
import { readSymbols, canReadDeeply } from './lib/reader.mjs';
import { buildIndex, checkMeaning } from './lib/verify.mjs';
import { readBack } from './lib/honesty.mjs';
import { fill, build, composeBrief } from './lib/agent.mjs';
import {
  childKeys, deleteNode, exists, levelView, listKeys, mapDir, parentOf,
  readNode, removeSubtree, renameSubtree, segmentsOf, slugSegment, summarise,
  updateNode, writeNode,
} from './lib/nodes.mjs';
import { surfaceEvidence, proposeParts, acceptParts } from './lib/surface.mjs';
import { readRequest, walkDown, buildOut } from './lib/explore.mjs';
import { staleNodes, rebuild } from './lib/drift.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const repoRoot = path.resolve(args.find(a => !a.startsWith('-')) || '.');
const port = Number((args.find(a => a.startsWith('--port')) || '').split('=')[1] || 4111);

if (!fs.existsSync(path.join(repoRoot, 'graphify-out', 'graph.json'))) {
  console.log(`no map for ${repoRoot} yet — reading the code now (free, no model)…`);
  try {
    execFileSync('graphify', ['update', repoRoot], {
      stdio: 'inherit',
      env: { ...process.env, GRAPHIFY_NO_BACKUP: '1', GRAPHIFY_FORCE: '1' },
      timeout: 600000,
    });
  } catch {
    console.error(`\nCould not read ${repoRoot}.`);
    console.error(`Try it by hand first:\n  graphify update ${repoRoot}\n`);
    process.exit(1);
  }
}

console.log('reading the map…');
const graph = loadGraph(repoRoot);
const index = buildIndex(graph);
console.log(`  ${graph.nodes.length} things, ${graph.links.length} links between them`);

// Everything one developer's own copy knows: the plan, where the boxes sit,
// and the derived watch index. None of it is ever written into the repo being
// described, because none of it is anything the team agreed on.
const STATE_DIR = path.join(here, 'state');
const STATE = path.join(STATE_DIR, safeName(repoRoot) + '.json');
const POSITIONS = path.join(STATE_DIR, safeName(repoRoot) + '.positions.json');
let saved = { plan: { boxes: [], edges: [], notes: [] }, meaning: {}, notes: '' };
try { saved = { ...saved, ...JSON.parse(fs.readFileSync(STATE, 'utf8')) }; } catch {}

const builds = new Map();

// ---------------------------------------------------------------- coverage

function coverage() {
  const manifest = path.join(repoRoot, 'graphify-out', 'manifest.json');
  let stale = 0, total = 0;
  try {
    const m = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    const entries = m.files || m;
    for (const [rel, info] of Object.entries(entries)) {
      total++;
      const abs = path.join(repoRoot, rel);
      try {
        const st = fs.statSync(abs);
        const was = info.mtime || info.mtime_ns / 1e9 || null;
        if (was && Math.abs(st.mtimeMs / 1000 - was) > 2) stale++;
      } catch { stale++; }
    }
  } catch { return { whole: false, text: 'map freshness unknown', detail: 'No fingerprints to compare against. Treat this map as possibly out of date.' }; }

  let head = null;
  try { head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot }).toString().trim(); } catch {}
  const sameCommit = head && graph.builtAtCommit && head.startsWith(graph.builtAtCommit.slice(0, 9));

  if (stale === 0 && sameCommit) {
    return { whole: true, text: `read from the real code · ${total} files`, detail: `Built at ${String(graph.builtAtCommit).slice(0, 9)}, which is the commit you are on. Nothing has changed since.` };
  }
  return {
    whole: false,
    text: stale ? `${stale} of ${total} files changed since this map was read` : 'map is from a different commit',
    detail: `This map was built at ${String(graph.builtAtCommit).slice(0, 9)}. ${stale} files have changed since. Anything you read here may be out of date. Rebuild with: graphify update ${repoRoot}`,
  };
}

// ---------------------------------------------------------------- what a box covers

function filesFor(box) {
  if (box.level === 'group') {
    const groups = rollup(graph.nodes);
    const g = groups.get(box.id.slice(6));
    return g ? [...new Set(g.nodes.map(n => n.source_file))] : [];
  }
  if (box.path) return [box.path];
  return [];
}

function symbolsFor(box) {
  const files = new Set(filesFor(box));
  const out = [];
  for (const n of graph.nodes) {
    if (!files.has(n.source_file)) continue;
    if (box.level === 'symbol' && n.id !== box.nodeId) continue;
    out.push(`${n.label} — ${n.source_file}:${(n.source_location || '').replace('L', '')}`);
  }
  return out;
}

// ---------------------------------------------------------------- routes

const routes = {
  'GET /api/repo': () => ({
    name: path.basename(repoRoot),
    root: repoRoot,
    commit: graph.builtAtCommit,
    things: graph.nodes.length,
    coverage: coverage(),
  }),

  'GET /api/map': ({ query }) => {
    const open = new Set((query.open || '').split('|').filter(Boolean));
    return view(graph, open);
  },

  'GET /api/search': ({ query }) => {
    const q = String(query.q || '').toLowerCase();
    const groups = rollup(graph.nodes);
    const groupOf = new Map();
    for (const [key, g] of groups) for (const n of g.nodes) groupOf.set(n.id, 'group:' + key);

    const hits = [];
    for (const n of graph.nodes) {
      if (!n.norm_label.includes(q) && !n.source_file.toLowerCase().includes(q)) continue;
      const gid = groupOf.get(n.id);
      hits.push({
        id: 'sym:' + n.id,
        label: n.label,
        path: n.source_file,
        open: [gid, 'file:' + n.source_file],
      });
      if (hits.length >= 30) break;
    }
    return { hits };
  },

  'GET /api/plan': () => saved,

  'POST /api/plan': ({ body }) => {
    saved = { plan: body.plan, meaning: body.meaning, notes: body.notes || '' };
    fs.mkdirSync(path.dirname(STATE), { recursive: true });
    fs.writeFileSync(STATE, JSON.stringify(saved, null, 2));
    writeMeaningFiles(saved.meaning);
    return { ok: true };
  },

  'POST /api/fill': async ({ body }) => {
    const box = body.box;
    const res = await fill({
      repoRoot,
      box,
      files: filesFor(box),
      symbols: symbolsFor(box),
    });
    const checked = checkMeaning(index, res.meaning);
    if (checked.problems.length && checked.checked.filter(c => !c.ok).length > checked.checked.length / 2) {
      throw new Error('Too much of that write-up named things that are not in this repo:\n' +
        checked.problems.slice(0, 5).join('\n'));
    }
    return {
      meaning: checked,
      cost: res.cost ? `$${res.cost.toFixed(3)}` : '',
    };
  },

  'POST /api/build': async ({ body }) => {
    const box = body.box;
    const plan = body.plan;
    requireCleanTree();

    const boxes = [...view(graph, new Set()).boxes, ...plan.boxes];
    const brief = composeBrief({
      box, plan, boxes, meaning: saved.meaning,
      lookup: id => {
        const n = graph.byId.get(String(id).replace(/^sym:/, ''));
        if (!n) return null;
        return { label: n.label, file: n.source_file, line: (n.source_location || '').replace('L', '') };
      },
    });

    const before = headCommit();
    const res = await build({ repoRoot, brief });
    const diff = gitDiff();
    const id = String(Date.now());
    builds.set(id, { box, brief, diff, before, files: changedFiles() });

    return {
      id, brief, diff,
      summary: res.summary,
      cost: res.cost ? `$${res.cost.toFixed(2)}` : '',
      tests: await maybeRunTests(changedFiles()),
      downstream: downstreamOf(plan, box),
    };
  },

  'POST /api/accept': ({ body }) => {
    const rec = builds.get(body.buildId);
    if (!rec) throw new Error('that build is gone');
    return readBack({ repoRoot, files: rec.files, boxTitle: rec.box.title });
  },

  'POST /api/reject': ({ body }) => {
    const rec = builds.get(body.buildId);
    if (!rec) throw new Error('that build is gone');
    for (const rel of rec.files) {
      try { execFileSync('git', ['checkout', '--', rel], { cwd: repoRoot }); }
      catch { try { fs.rmSync(path.join(repoRoot, rel)); } catch {} }
    }
    builds.delete(body.buildId);
    return { ok: true };
  },

  // ---------------------------------------------------------- the node map

  // One level, and only that level. The top of the map is an empty parent.
  'GET /api/map/nodes': ({ query }) => {
    const parent = String(query.parent || '') || null;
    return { parent, trail: trailTo(parent), ...levelView(repoRoot, parent) };
  },

  'GET /api/map/node': ({ query }) => {
    const key = String(query.key || '');
    const node = readNode(repoRoot, key);
    if (!node) throw new Error(`there is nothing on the map at ${key || 'that key'}`);
    return {
      node,
      trail: trailTo(parentOf(key)),
      children: summarise(repoRoot, childKeys(repoRoot, key)),
    };
  },

  // Straight at the store, because the two rules it refuses a node for are the
  // two this map cannot survive being broken.
  'POST /api/map/node': ({ body }) => {
    ensureMap();
    return { node: writeNode(repoRoot, (body && body.node) || {}) };
  },

  'POST /api/map/delete': ({ body }) => {
    const key = String((body && body.key) || '');
    if (!exists(repoRoot, key)) throw new Error(`there is nothing on the map at ${key || 'that key'}`);
    const inside = childKeys(repoRoot, key);
    // A node whose parent is gone has nowhere to live, and the store refuses to
    // write one. So taking out something with things inside it is all or none.
    if (inside.length && !(body && body.subtree)) {
      throw new Error(`${nameOf(key)} has ${inside.length} things inside it — take it with everything under it, or move those out first`);
    }
    const gone = body && body.subtree
      ? removeSubtree(repoRoot, key)
      : (deleteNode(repoRoot, key) ? [key] : []);
    return { gone };
  },

  // Renaming is file renames plus the arrows that pointed here. Nothing is read
  // and not a word of meaning is touched, so it stays cheap however deep it is.
  'POST /api/map/rename': ({ body }) => {
    const key = String((body && body.key) || '');
    const name = String((body && body.name) || '').trim();
    if (!name) throw new Error('a node needs a name a person would say');
    if (!exists(repoRoot, key)) throw new Error(`there is nothing on the map at ${key || 'that key'}`);

    const parent = parentOf(key);
    const next = parent ? `${parent}-${slugSegment(name)}` : slugSegment(name);
    const moved = renameSubtree(repoRoot, key, next);
    updateNode(repoRoot, next, { name });
    return { key: next, name, renamed: moved.renamed, retargeted: moved.retargeted };
  },

  'GET /api/map/positions': () => readPositions(),

  'POST /api/map/positions': ({ body }) => {
    writePositions({ pos: (body && body.pos) || {} });
    return { ok: true };
  },

  // The one call spent before anybody has asked for anything. It proposes; the
  // person picks; nothing is written until they do.
  'POST /api/surface': async () => {
    const res = await proposeParts({ repoRoot, evidence: surfaceEvidence(repoRoot) });
    return { parts: res.parts, cost: dollars(res.cost) };
  },

  'POST /api/surface/accept': ({ body }) => {
    ensureMap();
    return acceptParts(repoRoot, (body && body.names) || []);
  },

  'POST /api/ask': async ({ body }) => {
    const text = String((body && body.text) || '').trim();
    // Answering a question this asked last time hands the path straight back,
    // so the cheap reading call is not spent twice on the same sentence.
    const said = Array.isArray(body && body.path) && body.path.length
      ? { path: body.path, intent: body.intent === 'build' ? 'build' : 'explore', want: text, cost: 0 }
      : await readRequest({ repoRoot, text });

    ensureMap();
    const walk = await walkDown({
      repoRoot, index, graph,
      path: said.path,
      intent: said.intent,
      choices: (body && body.choices) || null,
      depth: body && body.depth,
    });

    // walkDown resolves the whole path before it writes anything, so a walk
    // that stops to ask has left the map exactly as it found it.
    return {
      ...walk,
      heard: { path: said.path, intent: said.intent, want: said.want },
      cost: dollars((said.cost || 0) + (walk.cost || 0)),
    };
  },

  'POST /api/map/explore': async ({ body }) => {
    const key = String((body && body.key) || '');
    if (!exists(repoRoot, key)) throw new Error(`there is nothing on the map at ${key || 'that key'} to open up`);
    ensureMap();
    const run = await buildOut({
      repoRoot, key, index, graph,
      depth: Number(body && body.depth) || 2,
    });
    return { ...run, below: levelView(repoRoot, key), cost: dollars(run.cost) };
  },

  'GET /api/map/stale': () => ({ stale: staleNodes(repoRoot, STATE_DIR, index) }),

  'POST /api/map/rebuild': () => {
    const out = rebuild(repoRoot, STATE_DIR, index);
    return { ...out, text: rebuildText(out) };
  },
};

// ---------------------------------------------------------------- git helpers

function headCommit() {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot }).toString().trim(); }
  catch { return null; }
}
function requireCleanTree() {
  let out = '';
  try { out = execFileSync('git', ['status', '--porcelain'], { cwd: repoRoot }).toString(); }
  catch { throw new Error('this folder is not a git repo, so a build could not be undone'); }
  // The meaning layer is written as you work, so an unsaved map is not a reason
  // to refuse a build — it is the normal state of one.
  const dirty = out.split('\n').filter(l => l.trim() && !l.includes('.graph-ide/') && !l.includes('.map/'));
  if (dirty.length) {
    throw new Error('There are already uncommitted changes here, so a build could not be cleanly undone.\n\n' +
      dirty.slice(0, 8).join('\n'));
  }
}
function gitDiff() {
  try { return execFileSync('git', ['diff', '--no-color'], { cwd: repoRoot, maxBuffer: 1 << 24 }).toString(); }
  catch { return ''; }
}
function changedFiles() {
  try {
    return execFileSync('git', ['status', '--porcelain'], { cwd: repoRoot }).toString()
      .split('\n').map(l => l.slice(3).trim()).filter(Boolean)
      .filter(f => !f.startsWith('.graph-ide/') && !f.startsWith('.map/'));
  } catch { return []; }
}

async function maybeRunTests(files) {
  // Run whatever check sits closest to the files that changed. In a repo made
  // of several packages the useful script is rarely the one at the top.
  const where = nearestPackage(files);
  if (!where) return null;
  const cmd = where.scripts.typecheck ? 'typecheck'
    : where.scripts.test ? 'test'
    : where.scripts.lint ? 'lint' : null;
  if (!cmd) return null;

  return new Promise(resolve => {
    execFile('npm', ['run', '--silent', cmd], { cwd: where.dir, timeout: 240000, maxBuffer: 1 << 22 },
      (err, stdout, stderr) => {
        const tail = (stdout + stderr).trim().split('\n').slice(-25).join('\n');
        const rel = path.relative(repoRoot, where.dir) || '.';
        const head = err
          ? `${cmd} in ${rel}/ failed. Some of these may have been failing before this change.`
          : `${cmd} in ${rel}/ passed.`;
        resolve(`${head}\n\n${tail}`);
      });
  });
}

function nearestPackage(files) {
  const seen = new Set();
  for (const rel of files) {
    let dir = path.dirname(path.join(repoRoot, rel));
    while (dir.startsWith(repoRoot)) {
      if (!seen.has(dir)) {
        seen.add(dir);
        const pkg = path.join(dir, 'package.json');
        if (fs.existsSync(pkg)) {
          try {
            const scripts = JSON.parse(fs.readFileSync(pkg, 'utf8')).scripts || {};
            if (scripts.typecheck || scripts.test || scripts.lint) return { dir, scripts };
          } catch {}
        }
      }
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }
  return null;
}

function downstreamOf(plan, box) {
  const out = [];
  for (const e of plan.edges) {
    if (e.from !== box.id) continue;
    const b = plan.boxes.find(x => x.id === e.to);
    out.push(b ? b.title : e.to.replace(/^(group|file|sym):/, ''));
  }
  return out;
}

// The meaning layer is the part worth keeping, so it lives in the repo it
// describes: one small file per box, so two people writing up different
// corners never touch the same file.
function writeMeaningFiles(meaning) {
  const dir = path.join(repoRoot, '.graph-ide', 'meaning');
  fs.mkdirSync(dir, { recursive: true });
  for (const [id, m] of Object.entries(meaning || {})) {
    const file = path.join(dir, safeName(id) + '.md');
    fs.writeFileSync(file, renderMeaning(id, m));
  }
}

function renderMeaning(id, m) {
  const list = (t, xs) => xs && xs.length ? `\n## ${t}\n\n${xs.map(x => '- ' + x).join('\n')}\n` : '';
  return `---
box: ${id}
---

# ${id.replace(/^(group|file|sym|plan):/, '')}

${m.whatItDoes || ''}
${list('What goes in', m.dataIn)}${list('What it decides', m.manipulation)}${list('What comes out', m.dataOut)}${list('Tables it touches', m.tablesTouched)}${list('Functions it calls', m.functionsCalled)}${m.observed ? `\n## What you would notice\n\n${m.observed}\n` : ''}`;
}

function safeName(s) { return String(s).replace(/[^\w.-]+/g, '_').slice(0, 120); }

// ---------------------------------------------------------------- the node map

// Made the first time somebody puts something on the map, so a repo nobody has
// mapped yet is left exactly as it was found.
function ensureMap() {
  fs.mkdirSync(mapDir(repoRoot), { recursive: true });
}

function nameOf(key) {
  const node = readNode(repoRoot, key);
  return (node && node.name) || segmentsOf(key).pop() || String(key);
}

// The way back up from the level being drawn. One small read per step, and no
// level is ever more than a few steps from the top.
function trailTo(key) {
  if (!key) return [];
  const segments = segmentsOf(key);
  const out = [];
  for (let i = 1; i <= segments.length; i++) {
    const k = segments.slice(0, i).join('-');
    out.push({ key: k, name: nameOf(k) });
  }
  return out;
}

// Where the boxes sit is one person's habit, not something the team agreed, so
// it lives here beside the plan and never goes into the repo being described.
function readPositions() {
  try { return { pos: JSON.parse(fs.readFileSync(POSITIONS, 'utf8')).pos || {} }; }
  catch { return { pos: {} }; }
}

function writePositions(next) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(POSITIONS, JSON.stringify(next, null, 2));
}

// Leaving a node alone is the point of a rebuild, so what it did not touch is
// said first and out loud.
function rebuildText({ untouched, moved, stale, gone }) {
  const left = `${untouched.length} left exactly as they were`;
  const news = [];
  if (moved.length) news.push(`${moved.length} found at a new address`);
  if (stale.length) news.push(`${stale.length} sitting on code that changed`);
  if (gone.length) news.push(`${gone.length} whose code is not here any more`);
  return news.length ? `${left}, ${news.join(', ')}.` : `nothing moved — ${left}.`;
}

function dollars(n) {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? `$${v.toFixed(3)}` : '';
}

// ---------------------------------------------------------------- serving

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const key = `${req.method} ${url.pathname}`;

  if (routes[key]) {
    let body = null;
    if (req.method === 'POST') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      try { body = JSON.parse(Buffer.concat(chunks).toString() || '{}'); }
      catch { return send(res, 400, { error: 'bad request' }); }
    }
    try {
      const query = Object.fromEntries(url.searchParams);
      const out = await routes[key]({ query, body });
      return send(res, 200, out);
    } catch (err) {
      console.error(key, '->', err.message);
      return send(res, 500, { error: err.message }, true);
    }
  }

  const file = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\//, '');
  const full = path.join(here, 'web', file);
  if (!full.startsWith(path.join(here, 'web'))) return send(res, 403, { error: 'no' });
  if (!fs.existsSync(full)) return send(res, 404, { error: 'not found' });
  res.writeHead(200, { 'content-type': TYPES[path.extname(full)] || 'text/plain' });
  fs.createReadStream(full).pipe(res);
});

function send(res, code, obj, plain = false) {
  if (plain) { res.writeHead(code, { 'content-type': 'text/plain' }); return res.end(obj.error); }
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

server.listen(port, '127.0.0.1', () => {
  const c = coverage();
  const mapped = listKeys(repoRoot).length;
  console.log(`\n  Iccarus — ${path.basename(repoRoot)} — http://127.0.0.1:${port}`);
  console.log(`  ${c.text}`);
  console.log(`  ${mapped ? `${mapped} things on the map` : 'nothing on the map yet — read the surface to name the big parts'}\n`);
});
