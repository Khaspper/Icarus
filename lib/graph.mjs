// The shape layer. Free, built from the real code, never saved.
//
// Loads the map a parser already produced, then rolls it up so the opening
// view is about twenty big boxes instead of thirteen thousand small ones.
// Clicking a box opens what is inside it. Nothing here calls a model.

import fs from 'node:fs';
import path from 'node:path';

export function loadGraph(repoRoot) {
  const file = path.join(repoRoot, 'graphify-out', 'graph.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const labelsFile = path.join(repoRoot, 'graphify-out', '.graphify_labels.json');
  let communityLabels = {};
  try { communityLabels = JSON.parse(fs.readFileSync(labelsFile, 'utf8')); } catch {}

  const nodes = raw.nodes.filter(n => n.source_file);
  const byId = new Map(nodes.map(n => [n.id, n]));
  const links = raw.links.filter(l => byId.has(l.source) && byId.has(l.target));

  return {
    repoRoot,
    builtAtCommit: raw.built_at_commit || null,
    nodes,
    links,
    byId,
    communityLabels,
    droppedLinks: raw.links.length - links.length,
    droppedNodes: raw.nodes.length - nodes.length,
  };
}

// --- rollup ----------------------------------------------------------------

function dirParts(file) {
  const p = file.split('/');
  p.pop();
  return p;
}

/**
 * Split the biggest group until there are about `target` of them, then fold
 * the ones too small to deserve a box into a single leftovers box.
 *
 * This is a rule, not a hand-made list, so it works on any repo.
 */
export function rollup(nodes, target = 20) {
  let groups = new Map([['', { prefix: [], nodes: [...nodes] }]]);

  while (groups.size < target + 6) {
    let best = null;
    for (const [key, group] of groups) {
      const kids = new Map();
      for (const n of group.nodes) {
        const d = dirParts(n.source_file);
        const next = d[group.prefix.length];
        const k = next === undefined ? '.' : next;
        if (!kids.has(k)) kids.set(k, []);
        kids.get(k).push(n);
      }
      if (kids.size < 2) continue;
      if (!best || group.nodes.length > best.group.nodes.length) best = { key, group, kids };
    }
    if (!best) break;
    groups.delete(best.key);
    for (const [k, ns] of best.kids) {
      const prefix = k === '.' ? best.group.prefix : [...best.group.prefix, k];
      const id = k === '.' ? best.key + '/.' : prefix.join('/');
      groups.set(id, { prefix, nodes: ns, isLoose: k === '.' });
    }
  }

  const total = nodes.length;
  const floor = Math.max(30, total * 0.012);
  const kept = new Map();
  const spill = [];
  for (const [key, group] of groups) {
    if (group.nodes.length >= floor) kept.set(key, group);
    else spill.push(...group.nodes);
  }
  if (spill.length) kept.set('(everything else)', { prefix: [], nodes: spill, isSpill: true });
  return kept;
}

// A plain-words name for a group, taken from the folder it sits in, with the
// strongest community label underneath it as a hint. Free, no model.
export function nameGroup(key, group, communityLabels) {
  if (group.isSpill) return { title: 'Everything else', subtitle: 'small corners of the repo', folder: '' };
  const folder = key.replace(/\/\.$/, '');
  const last = folder.split('/').filter(Boolean).pop() || folder;

  const counts = new Map();
  for (const n of group.nodes) {
    const label = communityLabels[String(n.community)];
    if (!label || /^Community \d+$/.test(label)) continue;
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  // Only borrow a community name when it actually covers most of the group.
  // A weak majority produces a confident-sounding wrong name, which is worse
  // than no name at all.
  let subtitle = '';
  if (counts.size) {
    const [label, hits] = [...counts].sort((a, b) => b[1] - a[1])[0];
    if (hits / group.nodes.length >= 0.35) subtitle = label;
  }
  return { title: prettify(last), subtitle, folder };
}

function prettify(name) {
  if (!name) return 'Root';
  return name.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// --- the view --------------------------------------------------------------

const SEP = ' ~> ';

/**
 * What to draw right now. `open` is the set of box ids the person has clicked
 * into. A group that is open is replaced by the files inside it; a file that
 * is open is replaced by the symbols inside it.
 *
 * Never returns more than `cap` boxes, and says so when it holds some back.
 */
export function view(graph, open = new Set(), cap = 45, perGroup = 16) {
  const groups = rollup(graph.nodes);

  let boxes = [];
  const memberOf = new Map(); // node id -> the box id that stands for it now
  let held = 0;

  for (const [key, group] of groups) {
    const gid = 'group:' + key;
    if (!open.has(gid)) {
      const named = nameGroup(key, group, graph.communityLabels);
      boxes.push({
        id: gid, level: 'group', title: named.title, subtitle: named.subtitle,
        folder: named.folder, count: group.nodes.length,
        files: new Set(group.nodes.map(n => n.source_file)).size,
      });
      for (const n of group.nodes) memberOf.set(n.id, gid);
      continue;
    }

    const files = new Map();
    for (const n of group.nodes) {
      if (!files.has(n.source_file)) files.set(n.source_file, []);
      files.get(n.source_file).push(n);
    }
    // Busiest files first, and only so many, so opening a big folder still
    // leaves a picture a person can read.
    const ranked = [...files].sort((a, b) => b[1].length - a[1].length);
    const room = Math.max(0, Math.min(perGroup, cap - boxes.length));
    for (const [file, ns] of ranked.slice(0, room)) {
      const fid = 'file:' + file;
      if (!open.has(fid)) {
        boxes.push({
          id: fid, level: 'file', title: file.split('/').pop(), subtitle: file,
          parent: gid, count: ns.length, path: file,
        });
        for (const n of ns) memberOf.set(n.id, fid);
      } else {
        for (const n of ns) {
          boxes.push({
            id: 'sym:' + n.id, level: 'symbol', title: n.label, subtitle: file,
            parent: fid, path: file, startLine: lineNumber(n.source_location),
            nodeId: n.id,
          });
          memberOf.set(n.id, 'sym:' + n.id);
        }
      }
    }
    held += Math.max(0, ranked.length - room);
  }

  // Roll the real links up to whatever box now stands for each end.
  // "contains" is left out: it is a third of all links and says only that a
  // thing sits inside a file, which the map already shows by opening the box.
  // One arrow per pair, not one per kind of link. Drawing "imports", "calls"
  // and "imports from" as three arrows between the same two boxes is three
  // lines on top of each other saying the same thing.
  const pairs = new Map();
  for (const l of graph.links) {
    if (l.relation === 'contains') continue;
    const a = memberOf.get(l.source), b = memberOf.get(l.target);
    if (!a || !b || a === b) continue;
    const key = a + SEP + b;
    let rec = pairs.get(key);
    if (!rec) { rec = { weight: 0, kinds: new Map() }; pairs.set(key, rec); }
    rec.weight++;
    rec.kinds.set(l.relation, (rec.kinds.get(l.relation) || 0) + 1);
  }
  let edges = [...pairs].map(([key, rec]) => {
    const [from, to] = key.split(SEP);
    const top = [...rec.kinds].sort((x, y) => y[1] - x[1])[0][0];
    return { from, to, relation: plainRelation(top), weight: rec.weight };
  });

  // When something is open, the groups that have nothing to do with it are
  // just clutter. Keep only the ones that actually touch what is open, so the
  // screen stays at about twenty boxes however deep you go. This has to happen
  // before the arrows are trimmed, or the trimming decides it for us.
  let hiddenGroups = 0;
  if (open.size) {
    const inFocus = new Set(boxes.filter(b => b.level !== 'group').map(b => b.id));
    const connected = new Set();
    for (const e of edges) {
      if (inFocus.has(e.from)) connected.add(e.to);
      if (inFocus.has(e.to)) connected.add(e.from);
    }
    const before = boxes.length;
    boxes = boxes.filter(b => b.level !== 'group' || connected.has(b.id));
    hiddenGroups = before - boxes.length;
    const kept = new Set(boxes.map(b => b.id));
    edges = edges.filter(e => kept.has(e.from) && kept.has(e.to));
  }

  edges.sort((a, b) => b.weight - a.weight);
  const edgeCap = 40;
  const hiddenEdges = Math.max(0, edges.length - edgeCap);
  edges = edges.slice(0, edgeCap);

  return { boxes, edges, heldBack: held, hiddenEdges, hiddenGroups };
}

function lineNumber(loc) {
  const m = /^L(\d+)/.exec(loc || '');
  return m ? Number(m[1]) : null;
}

// The words the parser uses, said the way a person would.
function plainRelation(r) {
  return ({
    imports: 'uses',
    imports_from: 'uses',
    calls: 'calls',
    re_exports: 'passes on',
    references: 'mentions',
    method: 'has',
    inherits: 'builds on',
    conceptually_related_to: 'related to',
  })[r] || r;
}
