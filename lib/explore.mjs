// Asking in words, working top down.
//
// "I'm fixing a bug in chunking in RAG" is a path: the big thing first, then
// the thing inside it. The answer is to find RAG or make it, read chunking
// properly, and name its neighbours — ingestion, retrieval — without opening
// any of them. That is what stops one question dragging in the whole repo, and
// it is why the map grows along the paths people actually walk.
//
// Three rules live here and every one of them is easy to get wrong:
//
//   - A lookup that is not an exact hit stops and asks, and writes NOTHING
//     before it does. Half a path of bare nodes nobody asked for is worse than
//     a question, and a second node for something already on the map splits the
//     map in two without anyone noticing.
//   - A node already read, with children already under it, is not read again.
//     That corner was paid for once, by whoever got there first.
//   - Nothing a model wrote reaches the map until the checker agrees the names
//     in it are real, and not one path survives into the meaning.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { ask, WORD_RULES_TEXT } from './agent.mjs';
import { checkMeaning } from './verify.mjs';
import { fingerprint } from './drift.mjs';
import {
  bareNode, childKeys, exists, levelView, parentOf, readNode, resolve,
  segmentsOf, slugSegment, topLevelKeys, writeNode,
} from './nodes.mjs';

const TYPES = ['user-action', 'feature-step', 'function', 'table', 'transformation', 'external-service'];
const STATUSES = ['existing', 'created', 'changed', 'not-applicable'];

// At most this many of anything a model hands back. The checker complains above
// eight, so the cap is the skill's own and is applied rather than reported.
const CAP = 8;

// Backend only, and the same list the surface read skips, so a grep for
// evidence does not come back full of stylesheets and build output.
const SKIP_DIR = /(?:^|\/)(?:node_modules|\.git|\.map|\.graph-ide|graphify-out|graphify-[^/]*|\.scratch|scratch|dist|build|\.next|coverage|public|components|styles|assets|docs|test|tests|__tests__)(?:\/|$)/;
const SKIP_EXT = /\.(?:tsx|jsx|css|scss|svg|png|jpe?g|gif|ico|lock|snap)$/i;

// Copies of the two rules nodes.mjs refuses a node for, so the meaning can be
// cleaned before it is offered rather than lost to the refusal.
const PATH_RE = /\w\/\w/;
const EXT_RE = /\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts|json|sql|py|go|rs|rb|java|php|css|scss|html|md|ya?ml|sh|toml|prisma|lock)\b/i;
const PRODUCT_RE = /\b(?:node|next|nuxt|vue|three|d3)\.js\b/i;
const ROUTE_RE = /^(?:(?:GET|POST|PUT|PATCH|DELETE)\s+)?\/\S*$/i;

// ---------------------------------------------------------------- the request

const REQUEST_SCHEMA = {
  type: 'object',
  properties: {
    path: {
      type: 'array',
      items: { type: 'string' },
      description: 'the names the sentence points at, biggest first then narrower, at most three',
    },
    intent: {
      type: 'string',
      enum: ['explore', 'build'],
      description: 'build when they want it filled in or worked on, explore when they want to understand it',
    },
    want: { type: 'string', description: 'what they are trying to do, one short sentence' },
  },
  required: ['path', 'intent', 'want'],
};

/**
 * One cheap call, and the only thing it does is turn a sentence into a path of
 * names. It reads nothing: the sentence is all the evidence there is, and a
 * model that starts reading code here would invent a level to be helpful.
 */
export async function readRequest({ repoRoot, text, model = 'haiku' }) {
  const said = String(text || '').trim();
  if (!said) throw new Error('there is nothing in that to read');

  const top = topLevelKeys(repoRoot).map(k => nameOfKey(repoRoot, k));

  const prompt = [
    'Somebody typed this into a map of a codebase:',
    '',
    `  ${said}`,
    '',
    'Turn it into the path through the map they are pointing at: the biggest',
    'thing first, then the narrower thing inside it.',
    '',
    top.length ? `Names already at the top of this map: ${top.join(', ')}` : 'This map is empty so far.',
    '',
    'Rules:',
    '- Only the levels the sentence actually says. "chunking in RAG" is two',
    '  levels. "chunking" on its own is one. Never add a level to be helpful,',
    '  and never guess at a parent they did not mention.',
    '- If one of their words is a name already on this map, spell it the way',
    '  the map spells it.',
    '- Answer from the sentence alone. Do not read any code.',
  ].join('\n');

  // "" is how the agent is told it gets no tools at all. An empty list would
  // leave the flag off and hand it the whole default set.
  const res = await ask({
    repoRoot, prompt, schema: REQUEST_SCHEMA, model,
    budget: '0.10', timeout: 60000, tools: [''],
  });

  const names = list(res.out.path).map(n => String(n).trim()).filter(Boolean).slice(0, 4);
  if (!names.length) throw new Error(`nothing in "${said}" names a part of the map`);

  return {
    path: names,
    intent: res.out.intent === 'build' ? 'build' : 'explore',
    want: String(res.out.want || said).trim(),
    cost: money(res.cost),
  };
}

// ---------------------------------------------------------------- walking down

/**
 * Resolve a path of names from the top, then read only the thing at the end of
 * it. `choices` is how a caller answers a question this asked last time, shaped
 * `{ "<levelIndex>": "<chosenKey>" }`, and the same walk is simply run again.
 */
export async function walkDown({
  repoRoot, index, graph, path: names, intent = 'explore', choices, depth, model, onStep,
}) {
  const wanted = list(names).map(n => String(n ?? '').trim()).filter(Boolean);
  if (!wanted.length) throw new Error('nothing was named to look for');

  // The whole path is resolved before a byte of it is written. Making the
  // parents on the way down and then stopping halfway to ask would leave a
  // trail of bare nodes nobody asked for.
  const steps = [];
  let parent = null;
  for (let i = 0; i < wanted.length; i++) {
    const name = wanted[i];
    const answered = choices && choices[String(i)];

    if (answered) {
      const chosen = String(answered);
      if (!exists(repoRoot, chosen) || (parentOf(chosen) || null) !== parent) {
        throw new Error(`${chosen} is not one of the things that was asked about`);
      }
      steps.push({ name: nameOfKey(repoRoot, chosen), key: chosen, make: false });
      parent = chosen;
      continue;
    }

    const found = resolve(repoRoot, parent, name);
    if (found.kind === 'ambiguous') {
      if (onStep) onStep({ step: 'asked', at: i, name });
      return {
        needsChoice: true, at: i, asked: name, candidates: found.candidates,
        path: wanted, created: [], cost: 0,
      };
    }
    steps.push({ name, key: found.key, make: found.kind === 'missing' });
    parent = found.key;
  }

  const created = [];
  for (const step of steps) {
    if (!step.make) continue;
    writeNode(repoRoot, bareNode(step.name, parentOf(step.key)));
    created.push(step.key);
    if (onStep) onStep({ step: 'named', key: step.key, name: step.name });
  }

  const target = steps[steps.length - 1];
  const keys = steps.map(s => s.key);
  const standing = readNode(repoRoot, target.key);

  // Already read, and already opened up. Do not redo it — drop a level and say
  // what is there.
  if (standing && standing.state === 'read' && childKeys(repoRoot, target.key).length) {
    if (onStep) onStep({ step: 'already', key: target.key, name: target.name });
    return {
      needsChoice: false, path: wanted, keys, created,
      explored: null, already: true,
      node: standing,
      neighbours: siblingsOf(repoRoot, target.key),
      children: childKeys(repoRoot, target.key).map(k => ({ key: k, name: nameOfKey(repoRoot, k) })),
      below: levelView(repoRoot, target.key),
      refused: [], unsure: [], problems: [], cost: 0,
    };
  }

  // Someone asking to build it out wants what is under it too. Someone asking
  // about it wants it read, with the level below named and left alone.
  const levels = depth != null ? Number(depth) : (intent === 'build' ? 2 : 1);
  const run = await buildOut({ repoRoot, key: target.key, depth: levels, index, graph, model, onStep });

  return {
    needsChoice: false, path: wanted, keys, created,
    explored: run.explored.includes(target.key) ? target.key : null,
    deeper: run.explored.filter(k => k !== target.key),
    already: false,
    node: readNode(repoRoot, target.key),
    neighbours: run.neighbours,
    children: run.children,
    below: levelView(repoRoot, target.key),
    refused: run.refused,
    unsure: run.unsure,
    problems: run.problems,
    cost: run.cost,
  };
}

// ---------------------------------------------------------------- one node

const NODE_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'plain English, what it does, and never the name of a file or folder' },
    type: { type: 'string', enum: TYPES },
    status: { type: 'string', enum: STATUSES },
    summary: { type: 'string', description: 'one sentence' },
    whatItDoes: { type: 'string', description: 'at most three short sentences' },
    dataIn: { type: 'array', items: { type: 'string' }, description: 'what goes in, up to 8, each under 12 words' },
    manipulation: { type: 'array', items: { type: 'string' }, description: 'what it decides or changes, up to 8' },
    dataOut: { type: 'array', items: { type: 'string' }, description: 'what comes out, up to 8' },
    tablesTouched: { type: 'array', items: { type: 'string' }, description: 'exact table names you saw, or empty' },
    functionsCalled: { type: 'array', items: { type: 'string' }, description: 'exact names of things it calls, or empty' },
    runsAs: { type: 'array', items: { type: 'string' }, description: 'the real functions this is built from, most useful first' },
    observed: { type: 'string', description: 'one sentence on what a person would notice' },
    inferredRequirement: { type: 'string', description: 'one sentence on what it is for' },
    files: { type: 'array', items: { type: 'string' }, description: 'the files you read this out of, up to 12' },
    children: { type: 'array', items: { type: 'string' }, description: 'the parts inside this, named as a person would say them, up to 8, empty when it cannot usefully be split' },
    runsBefore: { type: 'array', items: { type: 'string' }, description: 'the steps that run BEFORE this one under the same parent, names only, up to 6' },
    runsAfter: { type: 'array', items: { type: 'string' }, description: 'the steps that run AFTER this one under the same parent, names only, up to 6' },
    alongside: { type: 'array', items: { type: 'string' }, description: 'anything else under the same parent that is neither before nor after, names only, up to 6' },
    edges: {
      type: 'array',
      description: 'the arrows leaving this node',
      items: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'the name of the node it points at' },
          label: { type: 'string', description: 'three to six words saying what actually travels' },
        },
        required: ['to', 'label'],
      },
    },
    leaf: { type: 'boolean', description: 'true when breaking this apart would only restate what it already says' },
  },
  required: ['title', 'type', 'status', 'summary', 'whatItDoes', 'runsAs', 'children', 'runsBefore', 'runsAfter', 'alongside', 'edges'],
};

/**
 * One model call, and everything free is gathered first so the call is spent on
 * reading meaning rather than on finding where to look. It writes the node up,
 * names the parts inside it, and names the parts beside it — and those
 * neighbours are written out as bare names and nothing more. They are not
 * opened, not described, and they still count, because other people can point
 * arrows at them.
 */
export async function exploreNode({
  repoRoot, key, name, ancestors, index, graph, model = 'sonnet', onStep,
}) {
  if (!key) throw new Error('nothing was named to read');
  // Storing meaning nobody checked is the one thing this must never do.
  if (!index || !index.symbols) throw new Error('the checker has no index, so nothing can be written up');

  const standing = readNode(repoRoot, key);
  const called = String(name || (standing && standing.name) || segmentsOf(key).pop() || key);
  const above = list(ancestors).length ? list(ancestors).map(String) : ancestorNames(repoRoot, key);
  const parent = parentOf(key);

  if (onStep) onStep({ step: 'reading', key, name: called });

  const terms = searchTerms(called);
  const prompt = nodePrompt({
    name: called,
    ancestors: above,
    beside: siblingsOf(repoRoot, key).map(s => s.name),
    inside: childKeys(repoRoot, key).map(k => nameOfKey(repoRoot, k)),
    grep: grepRepo(repoRoot, terms),
    candidates: candidateSymbols(graph, terms),
  });

  const res = await ask({
    repoRoot, prompt, schema: NODE_SCHEMA, model,
    budget: '1.00', timeout: 300000, tools: ['Read', 'Grep', 'Glob'],
  });
  const out = res.out || {};
  const cost = money(res.cost);

  // A route is a real identifier a node runs as, the same way a function name
  // is. Everywhere else, a name with an address inside it is not a name.
  const runsAs = realNames(out.runsAs, true);
  const functionsCalled = realNames(out.functionsCalled);
  const tablesTouched = realNames(out.tablesTouched);

  const checked = checkMeaning(index, {
    whatItDoes: String(out.whatItDoes || ''),
    dataIn: strings(out.dataIn),
    manipulation: strings(out.manipulation),
    dataOut: strings(out.dataOut),
    tablesTouched,
    functionsCalled,
    runsAs,
    observed: String(out.observed || ''),
  });

  // More than half of what it claims is nowhere in the repo. That is not a
  // write-up with a mistake in it, it is a guess, so nothing at all is stored —
  // not the node, not the parts inside it, not the neighbours.
  const wrong = checked.checked.filter(c => !c.ok);
  if (wrong.length > checked.checked.length / 2) {
    const why = `${wrong.length} of the ${checked.checked.length} names in that write-up are not in this repo: ` +
      wrong.slice(0, 4).map(c => c.what).join(', ');
    if (onStep) onStep({ step: 'refused', key, name: called, why });
    return {
      key, name: called, node: null, refused: why,
      children: [], siblings: [], unsure: [],
      problems: checked.problems, checked: checked.checked,
      leaf: false, cost, ms: res.ms,
    };
  }

  // A path is not what a node means, so it never reaches the meaning. Where it
  // was read from is a different list, and that list lives in watches.
  const details = {
    runsAs,
    whatItDoes: stripText(out.whatItDoes, index),
    dataIn: cleanList(out.dataIn, index),
    manipulation: cleanList(out.manipulation, index),
    dataOut: cleanList(out.dataOut, index),
    tablesTouched,
    functionsCalled,
    observed: stripText(out.observed, index),
    inferredRequirement: stripText(out.inferredRequirement, index),
  };

  const arrows = [];
  const wanted = [];
  for (const edge of list(out.edges).slice(0, CAP)) {
    const to = String((edge && edge.to) || '').trim();
    const label = String((edge && edge.label) || '').trim();
    if (!to || !label) continue;
    const aim = aimAt(repoRoot, { key, parent, name: to });
    if (aim.unsure) { wanted.push(aim); continue; }
    // An arrow from a node to itself says nothing, and there is nowhere to
    // draw it.
    if (!aim.key) continue;
    arrows.push({ to: aim.key, label });
    if (aim.make) wanted.push(aim);
  }

  const node = {
    ...(standing || bareNode(called, parent)),
    key,
    name: (standing && standing.name) || called,
    state: 'read',
    title: stripText(out.title, index),
    type: TYPES.includes(out.type) ? out.type : 'feature-step',
    status: STATUSES.includes(out.status) ? out.status : 'existing',
    summary: stripText(out.summary, index),
    details,
    edges: mergeEdges(standing && standing.edges, arrows),
    watches: watchesFor(repoRoot, index, runsAs, out.files),
    checked: checked.checked,
    readAt: new Date().toISOString(),
    readAtCommit: headCommit(repoRoot),
  };
  // A fresh read is the ground under the node, so an older warning that the
  // ground moved has just been answered.
  delete node.stale;
  delete node.gone;
  delete node.moved;
  delete node.drift;

  try {
    writeNode(repoRoot, node);
  } catch (err) {
    // The store refuses a node that still reads like a location. Say so and
    // keep the name that was already there, rather than storing half of it.
    if (onStep) onStep({ step: 'refused', key, name: called, why: err.message });
    return {
      key, name: called, node: null, refused: err.message,
      children: [], siblings: [], unsure: [],
      problems: checked.problems, checked: checked.checked,
      leaf: false, cost, ms: res.ms,
    };
  }

  // The flow, folded back into one list. Asking "before, after, beside" gets
  // the neighbours a single vague question misses: a step that runs before this
  // one is on no arrow leaving it, so nothing else would ever surface it.
  out.siblings = [...list(out.runsBefore), ...list(out.runsAfter), ...list(out.alongside)];

  const leaf = Boolean(out.leaf) || node.type === 'function';
  const inside = leaf
    ? { made: [], unsure: [] }
    : nameOnto(repoRoot, key, out.children, new Set([key]));
  // Whatever an arrow points at has to be somewhere real, so a neighbour it
  // named on the way is written out with the rest of them.
  const beside = nameOnto(
    repoRoot, parent,
    [...list(out.siblings), ...wanted.filter(w => w.make).map(w => w.name)],
    new Set([key]),
  );

  if (onStep) onStep({ step: 'read', key, name: called, title: node.title, cost });

  return {
    key, name: called, node, refused: null,
    children: inside.made,
    siblings: beside.made,
    unsure: [...inside.unsure, ...beside.unsure, ...wanted.filter(w => w.unsure)],
    problems: checked.problems,
    checked: checked.checked,
    leaf,
    cost, ms: res.ms,
  };
}

// ---------------------------------------------------------------- building out

/**
 * Read the node, then read each part inside it, down to `depth` levels. A
 * single function is the floor, because it is the smallest thing with a name,
 * something going in and something coming out — and a node can be a leaf well
 * before that, when breaking it apart would only restate what it already says.
 */
export async function buildOut(first, second, third) {
  // The same call is spelled both ways in the notes this was written from, and
  // guessing wrong costs a crash at the one moment it is being demonstrated.
  const opts = typeof first === 'string' ? { repoRoot: first, key: second, depth: third } : (first || {});
  const {
    repoRoot, key, depth = 2, index, graph, model, onStep, limit = 4,
  } = opts;

  const levels = Math.max(1, Number(depth) || 1);
  const state = { explored: [], refused: [], skipped: [], unsure: [], problems: [], cost: 0 };
  const seen = new Set();

  // The node that was asked for is read whether or not it has been read
  // before, because somebody asked for it. Everything under it is only read
  // once, ever, by whoever got there first.
  const top = await once(repoRoot, key, { index, graph, model, onStep, state, seen, force: true });

  let frontier = top ? top.children.map(c => c.key) : [];
  for (let level = 1; level < levels && frontier.length; level++) {
    const next = [];
    await inBatches(frontier, limit, async child => {
      const done = await once(repoRoot, child, { index, graph, model, onStep, state, seen });
      if (done) next.push(...done.children.map(c => c.key));
    });
    frontier = next;
  }

  return {
    key,
    explored: state.explored,
    refused: state.refused,
    skipped: state.skipped,
    unsure: state.unsure,
    problems: state.problems,
    children: top ? top.children : [],
    neighbours: top ? top.siblings : [],
    node: top ? top.node : readNode(repoRoot, key),
    cost: state.cost,
  };
}

async function once(repoRoot, key, { index, graph, model, onStep, state, seen, force }) {
  if (!key || seen.has(key)) return null;
  seen.add(key);

  const standing = readNode(repoRoot, key);
  if (!standing) return null;

  // Already written up. Paid for once, by whoever first worked here, so it is
  // left exactly as it is and its own children carry the walk on.
  if (!force && standing.state === 'read') {
    state.skipped.push({ key, name: standing.name || key });
    if (onStep) onStep({ step: 'already', key, name: standing.name || key });
    return {
      node: standing,
      children: childKeys(repoRoot, key).map(k => ({ key: k, name: nameOfKey(repoRoot, k) })),
      siblings: [],
    };
  }

  let done;
  try {
    done = await exploreNode({
      repoRoot, key, name: standing.name, index, graph, model, onStep,
    });
  } catch (err) {
    // One bad corner does not cost the rest of the walk, and it does not cost
    // the name that was already on the map either.
    state.refused.push({ key, name: standing.name || key, why: err.message });
    if (onStep) onStep({ step: 'refused', key, name: standing.name || key, why: err.message });
    return null;
  }

  state.cost += done.cost;
  if (done.problems && done.problems.length) {
    for (const p of done.problems) state.problems.push({ key, why: p });
  }
  if (done.unsure && done.unsure.length) {
    for (const u of done.unsure) state.unsure.push({ key, ...u });
  }
  if (!done.node) {
    state.refused.push({ key, name: done.name, why: done.refused });
    return null;
  }

  state.explored.push(key);
  // A single function is the floor, and a leaf stops here whatever it named.
  const children = done.leaf ? [] : done.children;
  return { node: done.node, children, siblings: done.siblings };
}

// Four at a time. A wide node would otherwise start a dozen agents at once and
// then the machine, not the map, decides how that ends.
async function inBatches(items, limit, run) {
  const queue = [...items];
  const workers = [];
  const width = Math.max(1, Math.min(Number(limit) || 1, queue.length));
  for (let i = 0; i < width; i++) {
    workers.push((async () => {
      while (queue.length) await run(queue.shift());
    })());
  }
  await Promise.all(workers);
}

// ---------------------------------------------------------------- the prompt

function nodePrompt({ name, ancestors, beside, inside, grep, candidates }) {
  const lines = [];
  lines.push(`One node of a map of this repo is called "${name}".`);
  lines.push(ancestors.length
    ? `It sits inside ${[...ancestors].reverse().join(', inside ')}.`
    : 'It is one of the big parts of this product, at the top of the map.');
  lines.push('');
  lines.push('Read the real code, then say what this part of the product does and is.');
  lines.push('This one node only. The parts beside it are named at the end and');
  lines.push('are not being opened, so do not go and read them.');

  if (grep.files.length) {
    lines.push('', 'Where the words in that name show up, which is a hint and nothing more:');
    for (const f of grep.files) lines.push(`  ${f.file} (${f.hits} lines)`);
  }
  if (grep.lines.length) {
    lines.push('', 'Some of the lines that matched:');
    for (const l of grep.lines) lines.push(`  ${l}`);
  }
  if (candidates.length) {
    lines.push('', 'Things in this repo whose name looks related:');
    for (const c of candidates) lines.push(`  ${c}`);
  }
  if (!grep.files.length && !candidates.length) {
    lines.push('', grep.searched
      ? 'Nothing in the repo matched that name outright, so find it yourself,'
      : 'The quick search could not run here, so find it yourself,');
    lines.push('and if it genuinely is not in this repo, say so rather than');
    lines.push('inventing something that sounds right.');
  }

  lines.push('', beside.length
    ? `Already on the map beside it: ${beside.join(', ')}`
    : 'Nothing is on the map beside it yet.');
  lines.push(inside.length
    ? `Already on the map inside it: ${inside.join(', ')}`
    : 'Nothing is on the map inside it yet.');

  lines.push('', WORD_RULES_TEXT, '');
  lines.push('And these, because a node that breaks them cannot go on the map:');
  lines.push('- No file name, no folder, no path in the title, the summary or');
  lines.push('  anything in the details. Say what it does, not where it lives.');
  lines.push('  The files you read go in their own list and are not part of the');
  lines.push('  meaning.');
  lines.push('- runsAs, functionsCalled and tablesTouched are real names you saw');
  lines.push('  in the code. Every one of them is looked up afterwards, and a');
  lines.push('  write-up where most of them are missing is thrown away whole.');
  lines.push('- children are the real parts inside this, named the way a person');
  lines.push('  would say them. They are a group, not a folder: they can pull');
  lines.push('  code from four different directories.');
  lines.push('  A name is a LABEL, at most three words, never a sentence.');
  lines.push('  "Video clips", not "cutting a video into overlapping clips and');
  lines.push('  describing each one". The sentence is what that node will say');
  lines.push('  for itself when somebody opens it; the name is how it is filed.');
  lines.push('  Where the part is one function, its name is that function spelled');
  lines.push('  exactly as the code spells it.');
  lines.push('- Leave children empty and set leaf to true when breaking this');
  lines.push('  apart would only restate what it already says. A single function');
  lines.push('  is as small as this ever goes.');
  lines.push('- Then step back and say where this sits in the run. What has to');
  lines.push('  happen before it, and what happens once it is done? Those go in');
  lines.push('  runsBefore and runsAfter. A step that runs BEFORE this one will');
  lines.push('  never appear on an arrow leaving it, so it is invisible unless');
  lines.push('  you go looking — go looking. Read what calls this, and what the');
  lines.push('  thing it is part of does either side of it.');
  lines.push('  alongside is anything else under the same parent that is neither.');
  lines.push('  Name all three and nothing else — they are not being opened, so');
  lines.push('  do not describe them.');
  lines.push('  These are STEPS, not storage. A table this writes to is already');
  lines.push('  on an arrow; do not also list it as a neighbour.');
  lines.push('- Where a name is already on the map, spell it the way the map');
  lines.push('  spells it, so it lands on the node that is already there.');
  lines.push('- Every arrow leaving this says what actually travels, in three to');
  lines.push('  six concrete words. "hands over cleaned text", not "connects to".');
  return lines.join('\n');
}

// ---------------------------------------------------------------- free evidence

// A name a person says is rarely the name in the code. "Chunking" will not
// match chunkDocument, so the stem is searched for as well.
function searchTerms(name) {
  const words = String(name).match(/[A-Za-z0-9]+/g) || [];
  const terms = [String(name).trim(), slugSegment(name)];
  for (const w of words) {
    if (w.length >= 4) terms.push(w, stem(w));
  }
  const out = [];
  for (const t of terms) {
    const s = String(t).toLowerCase().trim();
    if (s.length >= 3 && !out.includes(s)) out.push(s);
  }
  return out.slice(0, 5);
}

function stem(word) {
  const w = String(word);
  const cut = w.replace(/(?:ings?|ed|tion|ion|als?|ers?|es|s)$/i, '');
  return cut.length >= 4 ? cut : w;
}

// Tracked files only, so node_modules costs nothing, and the rest of the noise
// is dropped here rather than in a pile of pathspec arguments.
function grepRepo(repoRoot, terms, topFiles = 12, sample = 16) {
  const hits = new Map();
  const lines = [];
  let searched = false;
  for (const term of terms) {
    let text = '';
    try {
      text = execFileSync('git', ['grep', '-I', '-i', '-n', '--fixed-strings', '-e', term], {
        cwd: repoRoot, maxBuffer: 1 << 24, timeout: 30000, stdio: ['ignore', 'pipe', 'ignore'],
      }).toString();
      searched = true;
    } catch (err) {
      // Failing with 1 means it looked and found nothing, which is an answer.
      // Anything else means it could not look, and saying "nothing matched"
      // then would be a lie the write-up would be built on.
      if (err && err.status === 1) searched = true;
      continue;
    }
    for (const line of text.split('\n')) {
      const at = line.indexOf(':');
      if (at < 1) continue;
      const file = line.slice(0, at);
      if (SKIP_DIR.test(file) || SKIP_EXT.test(file)) continue;
      hits.set(file, (hits.get(file) || 0) + 1);
      if (lines.length < sample * 4) lines.push(line.slice(0, 160));
    }
  }
  const ranked = [...hits].sort((a, b) => b[1] - a[1]).slice(0, topFiles);
  const kept = new Set(ranked.map(([f]) => f));
  return {
    searched,
    files: ranked.map(([file, count]) => ({ file, hits: count })),
    lines: lines.filter(l => kept.has(l.slice(0, l.indexOf(':')))).slice(0, sample),
  };
}

// The structural read is already loaded and already knows every name in the
// repo and the file it sits in, so the candidates are free.
function candidateSymbols(graph, terms, cap = 40) {
  if (!graph || !graph.nodes) return [];
  const byName = [];
  const byPlace = [];
  for (const n of graph.nodes) {
    const file = String(n.source_file || '');
    if (SKIP_DIR.test(file) || SKIP_EXT.test(file)) continue;
    const label = String(n.label || '');
    const norm = String(n.norm_label || label).toLowerCase();
    const line = `${label} — ${file}:${String(n.source_location || '').replace('L', '')}`;
    if (terms.some(t => norm.includes(t))) byName.push(line);
    else if (terms.some(t => file.toLowerCase().includes(t))) byPlace.push(line);
    if (byName.length >= cap) break;
  }
  return [...byName, ...byPlace].slice(0, cap);
}

// ---------------------------------------------------------------- storing it

/**
 * What the node watches, which is not what it means. The addresses come from
 * the index wherever they can, because a name the code really has is worth
 * more than a path a model remembered.
 */
function watchesFor(repoRoot, index, runsAs, said) {
  const functions = [];
  for (const fn of runsAs) {
    const s = String(fn).trim();
    if (s && !functions.includes(s)) functions.push(s);
  }

  const files = new Set();
  for (const fn of functions) {
    for (const hit of index.symbols.get(bareOf(fn)) || []) files.add(hit.file);
  }
  for (const f of strings(said, 12)) {
    const rel = String(f).trim().replace(/^\.?\//, '');
    if (!rel || files.has(rel)) continue;
    if (index.files.has(rel) || onDisk(repoRoot, rel)) files.add(rel);
  }

  const kept = [...files].sort().slice(0, 20);
  const fingerprints = {};
  for (const f of kept) {
    const print = fingerprint(repoRoot, f);
    if (print) fingerprints[f] = print;
  }
  return { functions, files: kept, fingerprints };
}

// An arrow a person drew is theirs: their label and their note survive a
// re-read untouched, and an arrow the model found to the same place is not
// drawn a second time on top of it.
function mergeEdges(had, found) {
  const mine = list(had).filter(e => e && e.to && (e.byHand || e.note));
  const taken = new Set(mine.map(e => e.to));
  const out = [...mine];
  for (const edge of found) {
    if (taken.has(edge.to)) continue;
    taken.add(edge.to);
    out.push(edge);
  }
  return out;
}

/**
 * Write names out as bare nodes: a name and nothing else, claiming nothing. A
 * name that is merely close to one already there is not written at all — it
 * comes back as something to ask about, because quietly making a second node
 * for the same thing is the one mistake that is expensive to undo.
 */
// A name is how a node is filed, so it has to stay short: the filename is the
// whole lookup, and a sentence turned into one is unreadable and unrenamable.
// The sentence is not lost — it is what the node says once somebody opens it.
const FILLER = new Set(['a', 'an', 'the', 'and', 'or', 'of', 'to', 'for', 'in',
  'into', 'on', 'with', 'from', 'by', 'at', 'as', 'its', 'their', 'each',
  'that', 'this', 'it', 'is', 'are', 'be', 's']);

function shortName(raw) {
  const name = String(raw ?? '').trim().replace(/[.!?]+$/, '');
  const words = name.split(/\s+/).filter(Boolean);
  if (words.length <= 3) return name;
  const kept = words.filter(w => !FILLER.has(w.toLowerCase().replace(/[^\w]/g, '')));
  return (kept.length ? kept : words).slice(0, 3).join(' ');
}

function nameOnto(repoRoot, parentKey, names, skip) {
  const made = [];
  const unsure = [];
  const done = new Set(skip || []);
  for (const raw of list(names).slice(0, CAP)) {
    const name = shortName(raw);
    if (!name) continue;
    const found = resolve(repoRoot, parentKey, name);
    if (found.kind === 'ambiguous') {
      unsure.push({ asked: name, candidates: found.candidates });
      continue;
    }
    if (done.has(found.key)) continue;
    done.add(found.key);
    if (found.kind === 'exact') {
      made.push({ key: found.key, name: nameOfKey(repoRoot, found.key), already: true });
      continue;
    }
    writeNode(repoRoot, bareNode(name, parentKey));
    made.push({ key: found.key, name, already: false });
  }
  return { made, unsure };
}

// Where an arrow points. A node beside this one first, because that is what an
// arrow almost always means; then something inside it.
function aimAt(repoRoot, { key, parent, name }) {
  const beside = resolve(repoRoot, parent, name);
  if (beside.kind === 'exact') {
    return beside.key === key ? { unsure: false, drop: true, key: null } : { unsure: false, key: beside.key, name };
  }
  const inside = resolve(repoRoot, key, name);
  if (inside.kind === 'exact') return { unsure: false, key: inside.key, name };
  if (beside.kind === 'ambiguous') return { unsure: true, asked: name, candidates: beside.candidates };
  // Nothing close either way, so the arrow lands on a new neighbour, which is
  // written out as a bare name so the arrow has somewhere real to go.
  return { unsure: false, make: true, key: beside.key, name };
}

// ---------------------------------------------------------------- plain words

/**
 * Take every location out of a piece of meaning. A path is not what a node
 * means, and the store refuses a node that still reads like one, so this runs
 * before anything is offered to it rather than after it is rejected.
 */
function stripText(text, index) {
  const s = String(text ?? '');
  if (!s.trim()) return '';
  const out = s.replace(/[^\s,;:()[\]{}"'`]+/g, token => clean(token, index));
  return out.replace(/[ \t]{2,}/g, ' ').replace(/\s+([,.;:!?])/g, '$1').trim();
}

function clean(token, index) {
  if (PRODUCT_RE.test(token)) return token;      // node.js is a thing people say
  if (EXT_RE.test(token)) return '';
  if (!token.includes('/')) return token;

  const bare = token.replace(/^\.?\/+/, '').replace(/[.,;:]+$/, '');
  const first = bare.split('/')[0];
  if (index && (index.files.has(bare) || index.dirs.has(bare) || index.dirs.has(first))) return '';
  if (/^[./]/.test(token) || (token.match(/\//g) || []).length > 1) return '';
  // Two plain words with a slash between them — "read/write" — is not an
  // address, but the check downstream cannot tell, so hand it the words.
  return bare.replace(/\//g, ' ');
}

function cleanList(value, index, cap = CAP) {
  return list(value)
    .map(v => stripText(v, index))
    .filter(Boolean)
    .slice(0, cap);
}

/**
 * Real names, which is a different job from prose: a function name with an
 * address inside it is not a function name, so it goes rather than being
 * reworded. Dropping it here and not later is what keeps the list of claims
 * and the list the checker ticked off the same list.
 */
function realNames(value, routesToo = false) {
  return strings(value).filter(s => (routesToo && ROUTE_RE.test(s)) || !locationLike(s));
}

function locationLike(text) {
  const s = String(text).replace(PRODUCT_RE, '');
  return PATH_RE.test(s) || EXT_RE.test(s);
}

// ---------------------------------------------------------------- small things

function list(value) {
  return Array.isArray(value) ? value : [];
}

function strings(value, cap = CAP) {
  const out = [];
  for (const v of list(value)) {
    const s = String(v ?? '').trim();
    if (s && !out.includes(s)) out.push(s);
  }
  return out.slice(0, cap);
}

function nameOfKey(repoRoot, key) {
  const node = readNode(repoRoot, key);
  return (node && node.name) || segmentsOf(key).pop() || String(key);
}

function ancestorNames(repoRoot, key) {
  const segments = segmentsOf(key);
  const out = [];
  for (let i = 1; i < segments.length; i++) out.push(nameOfKey(repoRoot, segments.slice(0, i).join('-')));
  return out;
}

function siblingsOf(repoRoot, key) {
  return childKeys(repoRoot, parentOf(key))
    .filter(k => k !== key)
    .map(k => ({ key: k, name: nameOfKey(repoRoot, k) }));
}

// The shape verify.mjs keys its index by. A lookup only works while both sides
// spell the name the same way.
function bareOf(label) {
  let s = String(label || '').trim();
  if (!s) return '';
  if (/^(GET|POST|PUT|PATCH|DELETE)\s/i.test(s)) return s.toLowerCase();
  s = s.replace(/\(.*\)$/, '').replace(/^\./, '');
  return s.split('.').pop().toLowerCase();
}

function onDisk(repoRoot, rel) {
  try { return fs.statSync(path.join(repoRoot, rel)).isFile(); } catch { return false; }
}

function headCommit(repoRoot) {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: repoRoot, stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim();
  } catch {
    return null;
  }
}

function money(cost) {
  const n = Number(cost);
  return Number.isFinite(n) ? n : 0;
}
