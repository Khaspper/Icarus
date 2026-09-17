// Iccarus — the node map. Behaviour only: every id and class touched here is
// already in index.html and styles.css.
//
// app.js owns the Code tab and listens on window for mousemove, mouseup and
// keydown. Every window handler below leaves the moment the Code tab is on top,
// so the two never pull on the same gesture.

const $ = id => document.getElementById(id);
const SVGNS = 'http://www.w3.org/2000/svg';

const E = {
  tabMap: $('tabMap'), tabCode: $('tabCode'), mapPane: $('mapPane'), codePane: $('codePane'),
  outline: $('mOutline'), rebuild: $('mRebuild'),
  ask: $('mAsk'), askGo: $('mAskGo'), askHint: $('mAskHint'), surface: $('mSurface'),
  stage: $('mStage'), world: $('mWorld'), edgeLayer: $('mEdgeLayer'), boxLayer: $('mBoxLayer'),
  dots: $('mDots'), trail: $('mTrail'), empty: $('mEmpty'), status: $('mStatus'),
  zoomIn: $('mZoomIn'), zoomOut: $('mZoomOut'), zoomFit: $('mZoomFit'), zoomLevel: $('mZoomLevel'),
  inspectorEmpty: $('mInspectorEmpty'), inspectorBody: $('mInspectorBody'),
  sheet: $('mSheet'), sheetTitle: $('mSheetTitle'), sheetBody: $('mSheetBody'),
  sheetFoot: $('mSheetFoot'), sheetClose: $('mSheetClose'), scrim: $('mScrim'),
};

const S = {
  parent: null, trail: [], nodes: [], edges: [],
  pos: new Map(),    // key -> {x,y} in world coordinates: what is actually drawn
  size: new Map(),   // key -> {w,h}
  saved: {},         // what the positions route holds, which is one person's own
  sel: null, drag: null, pan: null,
  view: { x: 0, y: 0, k: 1 },
  ask: { text: '', path: null, intent: 'explore', choices: {} },
};

// ------------------------------------------------------------------ plumbing

async function api(path, body) {
  const res = await fetch(path, body === undefined ? undefined : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const text = await res.text();
  // A refusal comes back as plain words already meant for a person.
  if (!res.ok) throw new Error(text.trim() || `the server said ${res.status}`);
  return text ? JSON.parse(text) : {};
}

function say(words, busy) {
  E.status.textContent = '';
  if (!words) { E.status.classList.remove('show'); return; }
  if (busy) E.status.appendChild(el('span', 'spin'));
  E.status.appendChild(document.createTextNode(words));
  E.status.classList.add('show');
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function svgEl(tag, cls, attrs) {
  const n = document.createElementNS(SVGNS, tag);
  if (cls) n.setAttribute('class', cls);
  for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, v);
  return n;
}

function parentKey(key) {
  const parts = String(key || '').split('-').filter(Boolean);
  return parts.length > 1 ? parts.slice(0, -1).join('-') : null;
}

const mapOn = () => E.mapPane.classList.contains('on');

// ------------------------------------------------------------------ wording

const TYPE_SAID = {
  'user-action': 'user action', 'feature-step': 'feature step', function: 'function',
  table: 'table', transformation: 'transformation', 'external-service': 'outside service',
};
const STATUS_SAID = {
  existing: 'already there', created: 'new', changed: 'changed', 'not-applicable': 'not ours',
};

const typeSaid = c => (c.state === 'planned' ? 'planned' : TYPE_SAID[c.type] || c.type || 'part');
const chipSaid = c => (c.stale ? 'code changed' : STATUS_SAID[c.status] || c.status || '');
const realsSaid = c => (c.runsAs || []).join(', ');

// ------------------------------------------------------------------ the card

// Text is measured by eye rather than by the browser, so a level lays out in
// one pass without ever reading geometry back.
const PER = { title: 6.9, type: 5.4, real: 6.0, pill: 5.6, label: 5.3 };
const CARD = { pad: 16, min: 158, max: 268 };

function fit(text, per, room) {
  const s = String(text || '');
  const max = Math.floor(room / per);
  return s.length <= max ? s : s.slice(0, Math.max(1, max - 1)) + '…';
}

function sizeOf(card) {
  const room = CARD.max - CARD.pad * 2;
  const wide = n => Math.min(CARD.max, Math.max(CARD.min, n + CARD.pad * 2));
  if (card.state === 'named') return { w: wide(card.name.length * PER.title), h: 52 };
  return {
    w: wide(Math.max(
      Math.min(room, (card.title || card.name).length * PER.title),
      typeSaid(card).length * PER.type,
      Math.min(room, realsSaid(card).length * PER.real))),
    h: 92,
  };
}

function rectOf(key) {
  const p = S.pos.get(key) || { x: 0, y: 0 };
  const s = S.size.get(key) || { w: CARD.min, h: 92 };
  return { x: p.x, y: p.y, w: s.w, h: s.h };
}

// ------------------------------------------------------------------ layout

// Left to right from the arrows, the way the Code tab reads. A position already
// saved, and a leaf carried in from the level above, both beat this.
function layout(cards, edges, kept) {
  // A kept card is out of this entirely: it is already where it belongs, and
  // leaving a slot for it would only punch a hole in the new level.
  const free = cards.filter(c => !kept.has(c.key));
  if (!free.length) return;
  const here = new Map(free.map(c => [c.key, c]));
  const links = edges.filter(e => here.has(e.from) && here.has(e.to) && e.from !== e.to);

  const layer = new Map(free.map(c => [c.key, 0]));
  for (let pass = 0; pass < 6; pass++) {
    let moved = false;
    for (const e of links) {
      const want = layer.get(e.from) + 1;
      if (layer.get(e.to) < want) { layer.set(e.to, want); moved = true; }
    }
    if (!moved) break;
  }

  const cols = new Map();
  for (const c of free) {
    const l = Math.min(layer.get(c.key) || 0, 6);
    if (!cols.has(l)) cols.set(l, []);
    cols.get(l).push(c);
  }

  // Inside a column, sit each card near the average height of what it touches,
  // so the arrows between columns stop crossing each other.
  const columns = [...cols].sort((a, b) => a[0] - b[0]).map(pair => pair[1]);
  const order = new Map(free.map((c, i) => [c.key, i]));
  for (let pass = 0; pass < 4; pass++) {
    for (const list of columns) {
      for (const c of list) {
        const near = links.filter(e => e.from === c.key || e.to === c.key)
          .map(e => order.get(e.from === c.key ? e.to : e.from)).filter(v => v !== undefined);
        if (near.length) order.set(c.key, near.reduce((a, b) => a + b, 0) / near.length);
      }
      list.sort((a, b) => order.get(a.key) - order.get(b.key));
      list.forEach((c, i) => order.set(c.key, i));
    }
  }

  // A column a dozen cards tall makes a picture nobody can read without zooming
  // out, so a tall one wraps into lanes side by side.
  const COL_GAP = 92, ROW_GAP = 26, TALLEST = 7;
  const auto = new Map();
  let x = 0;
  for (const list of columns) {
    const lanes = Math.ceil(list.length / TALLEST) || 1;
    const perLane = Math.ceil(list.length / lanes);
    let laneX = x, widestColumn = 0;
    for (let lane = 0; lane < lanes; lane++) {
      const slice = list.slice(lane * perLane, (lane + 1) * perLane);
      if (!slice.length) continue;
      const widest = Math.max(...slice.map(c => S.size.get(c.key).w));
      let y = 0;
      for (const c of slice) {
        auto.set(c.key, { x: laneX + (widest - S.size.get(c.key).w) / 2, y });
        y += S.size.get(c.key).h + ROW_GAP;
      }
      for (const c of slice) auto.get(c.key).y -= (y - ROW_GAP) / 2;
      laneX += widest + 20;
      widestColumn = laneX - x;
    }
    x += widestColumn + COL_GAP;
  }

  // A carried leaf does not move a pixel, so the new level is pushed clear of
  // it rather than drawn over it.
  if (kept.size) {
    const box = list => ({
      l: Math.min(...list.map(v => v.x)), r: Math.max(...list.map(v => v.x + v.w)),
      t: Math.min(...list.map(v => v.y)), b: Math.max(...list.map(v => v.y + v.h)),
    });
    const held = box([...kept].map(k => rectOf(k)));
    const loose = box(free.map(c => ({ ...auto.get(c.key), ...S.size.get(c.key) })));
    const dx = held.r + COL_GAP - loose.l, dy = (held.t + held.b - loose.t - loose.b) / 2;
    for (const c of free) auto.set(c.key, { x: auto.get(c.key).x + dx, y: auto.get(c.key).y + dy });
  }

  for (const c of free) {
    const saved = S.saved[c.key];
    S.pos.set(c.key, saved ? { x: saved.x, y: saved.y } : auto.get(c.key));
  }
}

// ------------------------------------------------------------------ drawing

function draw() {
  drawEdges(); drawBoxes(); drawOutline(); drawTrail();
  E.empty.hidden = S.nodes.length > 0;
  applyView();
}

const boxClass = card => ['mbox', `s-${card.state}`,
  card.stale ? 'stale' : '', card.hasChildren ? 'haskids' : '', card.key === S.sel ? 'sel' : '',
].filter(Boolean).join(' ');

function svgText(cls, x, y, text, attrs) {
  const n = svgEl('text', cls, { x, y, ...(attrs || {}) });
  n.textContent = text;
  return n;
}

function drawBoxes() {
  E.boxLayer.textContent = '';
  for (const card of S.nodes) {
    const r = rectOf(card.key), room = r.w - CARD.pad * 2, named = card.state === 'named';
    const g = svgEl('g', boxClass(card), { transform: `translate(${r.x} ${r.y})` });
    g.dataset.key = card.key;
    g.appendChild(svgEl('rect', 'mshell', { x: 0, y: 0, width: r.w, height: r.h }));
    g.appendChild(svgEl('rect', 'maccent', { x: 5, y: 10, width: 3.5, height: r.h - 20 }));
    g.appendChild(svgText('mtitle', CARD.pad, named ? 24 : 26, fit(card.title || card.name, PER.title, room)));
    g.appendChild(svgText('mtype', CARD.pad, named ? 40 : 44, named ? 'only a name' : typeSaid(card)));
    g.appendChild(svgText('mreal', CARD.pad, 60, fit(realsSaid(card), PER.real, room)));

    const chip = svgEl('g', 'mchip'), words = chipSaid(card);
    chip.appendChild(svgEl('rect', 'mpill-bg',
      { x: CARD.pad, y: r.h - 24, width: words.length * PER.pill + 14, height: 16 }));
    chip.appendChild(svgText('mpill', CARD.pad + 7, r.h - 12, words));
    g.appendChild(chip);
    E.boxLayer.appendChild(g);
  }
}

// A cubic's midpoint, which is where the label plate sits.
function edgeShape(a, b) {
  if (b.x < a.x + a.w) {
    const p = { x: a.x + a.w / 2, y: a.y + a.h }, q = { x: b.x + b.w / 2, y: b.y + b.h };
    const dip = Math.max(44, Math.abs(q.x - p.x) / 3);
    return {
      d: `M${p.x} ${p.y} C${p.x} ${p.y + dip} ${q.x} ${q.y + dip} ${q.x} ${q.y}`,
      mx: (p.x + q.x) / 2, my: (p.y + q.y) / 2 + dip * 0.75,
    };
  }
  const p = { x: a.x + a.w, y: a.y + a.h / 2 }, q = { x: b.x - 5, y: b.y + b.h / 2 };
  const bend = Math.max(34, (q.x - p.x) / 2);
  return {
    d: `M${p.x} ${p.y} C${p.x + bend} ${p.y} ${q.x - bend} ${q.y} ${q.x} ${q.y}`,
    mx: (p.x + q.x) / 2, my: (p.y + q.y) / 2,
  };
}

function drawEdges() {
  E.edgeLayer.textContent = '';
  const drawn = new Map(S.nodes.map(c => [c.key, c]));
  for (const e of S.edges) {
    const from = drawn.get(e.from);
    if (!from) continue;
    const a = rectOf(e.from), to = drawn.get(e.to);
    const shape = to ? edgeShape(a, rectOf(e.to))
      : { d: `M${a.x + a.w} ${a.y + a.h / 2} h 54`, mx: a.x + a.w + 27, my: a.y + a.h / 2 };

    const bits = ['medge'];
    // A plan is dashed on every arrow touching it, so a map with plans in it
    // never reads as a map of what runs.
    if (from.state === 'planned' || (to && to.state === 'planned')) bits.push('planned');
    if (!to) bits.push('offlevel');
    if (S.sel && (e.from === S.sel || e.to === S.sel)) bits.push('hot');
    E.edgeLayer.appendChild(svgEl('path', bits.join(' '), { d: shape.d }));

    // What travels is the whole point of this map, so a label never hides.
    const words = e.label || (to ? '' : 'leaves this level');
    if (!words) continue;
    const w = words.length * PER.label + 10;
    E.edgeLayer.appendChild(svgEl('rect', 'melabel-bg',
      { x: shape.mx - w / 2, y: shape.my - 9, width: w, height: 16 }));
    E.edgeLayer.appendChild(svgText('melabel', shape.mx, shape.my + 2.5, words, { 'text-anchor': 'middle' }));
  }
}

function drawOutline() {
  E.outline.textContent = '';
  if (!S.nodes.length) return;
  for (const card of S.nodes) {
    const row = el('div', `item s-${card.state}${card.stale ? ' stale' : ''}${card.key === S.sel ? ' on' : ''}`);
    row.appendChild(el('span', 'tw', card.hasChildren ? '›' : ''));
    row.appendChild(el('span', 'dotk'));
    row.appendChild(el('span', 'nm', card.name));
    row.appendChild(el('span', 'n', card.stale ? 'code changed' : ''));
    row.addEventListener('click', () => select(card.key));
    row.addEventListener('dblclick', () => { if (card.hasChildren) openNode(card.key); });
    E.outline.appendChild(row);
  }
}

function drawTrail() {
  E.trail.textContent = '';
  const steps = [{ key: null, name: 'Everything' }, ...S.trail];
  steps.forEach((step, i) => {
    if (i) E.trail.appendChild(el('span', null, '›'));
    const b = el('button', null, step.name);
    if (i < steps.length - 1) b.addEventListener('click', () => loadLevel(step.key));
    E.trail.appendChild(b);
  });
}

// ------------------------------------------------------------------ the view

function applyView() {
  const { x, y, k } = S.view;
  E.world.setAttribute('transform', `translate(${x} ${y}) scale(${k})`);
  E.dots.setAttribute('patternTransform', `translate(${x} ${y}) scale(${k})`);
  E.zoomLevel.textContent = `${Math.round(k * 100)}%`;
}

function fitView() {
  if (!S.nodes.length) { S.view = { x: 0, y: 0, k: 1 }; applyView(); return; }
  const v = S.nodes.map(c => rectOf(c.key));
  const l = Math.min(...v.map(r => r.x)), t = Math.min(...v.map(r => r.y));
  const r = Math.max(...v.map(q => q.x + q.w)), b = Math.max(...v.map(q => q.y + q.h));
  const box = E.stage.getBoundingClientRect();
  const k = Math.min(1.1, Math.max(0.3, Math.min(
    (box.width - 160) / Math.max(1, r - l), (box.height - 160) / Math.max(1, b - t))));
  S.view = { k, x: box.width / 2 - ((l + r) / 2) * k, y: box.height / 2 - ((t + b) / 2) * k };
  applyView();
}

function zoomTo(k, at) {
  const box = E.stage.getBoundingClientRect();
  const cx = at ? at.x - box.left : box.width / 2, cy = at ? at.y - box.top : box.height / 2;
  const next = Math.min(2.4, Math.max(0.2, k));
  S.view.x = cx - (cx - S.view.x) * (next / S.view.k);
  S.view.y = cy - (cy - S.view.y) * (next / S.view.k);
  S.view.k = next;
  applyView();
}

function toWorld(ev) {
  const box = E.stage.getBoundingClientRect();
  return { x: (ev.clientX - box.left - S.view.x) / S.view.k, y: (ev.clientY - box.top - S.view.y) / S.view.k };
}

// ------------------------------------------------------------------ a level

async function loadLevel(parent, carry) {
  say('Reading the map…', true);
  try {
    const q = parent ? `?parent=${encodeURIComponent(parent)}` : '';
    const view = await api(`/api/map/nodes${q}`);
    S.parent = view.parent || null;
    S.trail = view.trail || [];
    S.nodes = view.nodes || [];
    S.edges = view.edges || [];
    S.sel = null;
    showInspector(null);

    const here = new Set(S.nodes.map(c => c.key));
    const kept = new Set();
    for (const leaf of carry || []) {
      if (here.has(leaf.card.key)) continue;
      S.nodes.push(leaf.card);
      S.pos.set(leaf.card.key, leaf.at);
      S.size.set(leaf.card.key, leaf.size);
      kept.add(leaf.card.key);
    }
    // An arrow a carried leaf had to the node just opened has nothing left to
    // point at — that node is the level you are now standing in — and one to a
    // node left behind on the level above would point off the picture.
    const drawn = new Set(S.nodes.map(c => c.key));
    for (const leaf of carry || []) {
      for (const e of leaf.edges) if (drawn.has(e.to)) S.edges.push(e);
    }

    for (const c of S.nodes) if (!kept.has(c.key)) S.size.set(c.key, sizeOf(c));
    layout(S.nodes, S.edges, kept);
    draw();
    if (!kept.size) fitView();
    say('');
  } catch (err) {
    say(err.message);
  }
}

// Opening a node keeps the leaves already on screen that connect to it, exactly
// where they are. Drawing one of them a second time somewhere else is the one
// thing this must never do.
function openNode(key) {
  const carry = [];
  for (const card of S.nodes) {
    if (card.key === key || card.hasChildren) continue;
    const touching = S.edges.some(e =>
      (e.from === card.key && e.to === key) || (e.from === key && e.to === card.key));
    if (!touching) continue;
    carry.push({
      card,
      at: { ...S.pos.get(card.key) },
      size: { ...S.size.get(card.key) },
      edges: S.edges.filter(e => e.from === card.key),
    });
  }
  loadLevel(key, carry);
}

// ------------------------------------------------------------------ picking

function select(key) {
  S.sel = key;
  drawEdges(); drawBoxes(); drawOutline();
  if (!key) { showInspector(null); return; }
  api(`/api/map/node?key=${encodeURIComponent(key)}`)
    .then(res => { if (S.sel === key) showInspector(res.node); })
    .catch(err => say(err.message));
}

function sec(heading, body) {
  const s = el('div', 'sec');
  s.appendChild(el('h4', null, heading));
  for (const n of [].concat(body)) if (n) s.appendChild(n);
  return s;
}

function bullets(items) {
  if (!items || !items.length) return null;
  const ul = el('ul');
  for (const i of items) ul.appendChild(el('li', null, i));
  return ul;
}

function listSec(heading, items) {
  const ul = bullets(items);
  return ul ? sec(heading, ul) : null;
}

function linkRow(dir, name, rel, tail) {
  const row = el('div', 'link-row');
  if (dir) row.appendChild(el('span', 'arrowdir', dir));
  const who = el('span', 'who');
  who.appendChild(el('span', 'nm', name));
  for (const line of [].concat(rel || [])) if (line) who.appendChild(el('span', 'rel', line));
  row.appendChild(who);
  if (tail) row.appendChild(el('span', 'w', tail));
  return row;
}

function showInspector(node) {
  E.inspectorBody.textContent = '';
  E.inspectorEmpty.hidden = Boolean(node);
  E.inspectorBody.hidden = !node;
  if (!node) return;

  const add = n => n && E.inspectorBody.appendChild(n);
  const d = node.details || {}, named = node.state === 'named', plan = node.state === 'planned';

  const head = el('div', 'ins-head');
  head.appendChild(el('div', 'ins-kind', named ? 'only a name' : typeSaid(node)));
  head.appendChild(el('div', 'ins-title', node.title || node.name));
  add(head);

  const tags = el('div', 'sec');
  tags.appendChild(el('span', `tag ${plan ? 'plan' : named ? 'grey' : 'built'}`,
    named ? 'claims nothing yet' : plan ? 'planned' : 'read from the code'));
  if (node.stale) tags.appendChild(el('span', 'tag bad', 'code changed'));
  add(tags);

  if (node.summary) add(sec('What it is', el('p', null, node.summary)));
  if (d.whatItDoes) add(sec('What it does', el('p', null, d.whatItDoes)));
  add(listSec('What goes in', d.dataIn));
  add(listSec('What it decides', d.manipulation));
  add(listSec('What comes out', d.dataOut));
  add(listSec('Tables it touches', d.tablesTouched));
  add(listSec('What it calls', d.functionsCalled));

  const arrows = el('div');
  for (const e of S.edges) {
    const out = e.from === node.key;
    if (!out && e.to !== node.key) continue;
    const other = out ? e.to : e.from;
    const row = linkRow(out ? '→' : '←', nameFor(other),
      e.note || e.label || 'no label yet', e.byHand ? 'by hand' : '');
    row.addEventListener('click', () => { if (S.nodes.some(c => c.key === other)) select(other); });
    arrows.appendChild(row);
  }
  if (arrows.childElementCount) add(sec('Arrows in and out', arrows));

  const checks = el('div');
  for (const c of node.checked || []) {
    const row = el('div', 'check');
    row.appendChild(el('span', c.ok ? 'ok' : 'no', c.ok ? '✓' : '✗'));
    row.appendChild(el('span', null, c.ok ? c.what : `${c.what} — ${c.why}`));
    checks.appendChild(row);
  }
  if (checks.childElementCount) add(sec('Against the repo', checks));

  const acts = el('div', 'act');
  const card = S.nodes.find(c => c.key === node.key);
  if (card && card.hasChildren) acts.appendChild(button('secondary', 'Open it up', () => openNode(node.key)));
  if (!plan) {
    const build = button('primary', named ? 'Build this out' : 'Read it again', () => explore(node.key, build));
    acts.appendChild(build);
    acts.appendChild(el('div', 'hint', 'One model call. It reads the code under this and nothing else.'));
  }
  if (acts.childElementCount) add(acts);

  // Last, and said plainly, because where code lives is not what a node means.
  const w = node.watches || {}, files = w.files || [], fns = w.functions || [];
  const watched = el('div');
  watched.appendChild(el('p', 'muted',
    'Not what this node means. Only what it is watching, so a change to it gets noticed.'));
  if (fns.length) watched.appendChild(bullets(fns));
  for (const f of files) watched.appendChild(el('div', 'ins-path', f));
  if (!fns.length && !files.length) watched.appendChild(el('p', 'muted', 'Nothing yet — nobody has read the code under this.'));
  add(sec('The code it watches', watched));
}

function button(cls, words, onClick) {
  const b = el('button', cls, words);
  b.addEventListener('click', onClick);
  return b;
}

function nameFor(key) {
  const card = S.nodes.find(c => c.key === key);
  return card ? card.name : key;
}

// ------------------------------------------------------------------ the sheet

function openSheet(title, body, foot) {
  E.sheetTitle.textContent = title;
  E.sheetBody.textContent = '';
  E.sheetFoot.textContent = '';
  E.sheetBody.appendChild(body);
  if (foot) E.sheetFoot.appendChild(foot);
  E.sheet.hidden = false;
  E.scrim.hidden = false;
}

function closeSheet() {
  E.sheet.hidden = true;
  E.scrim.hidden = true;
}

// ------------------------------------------------------------------ the work

async function surface() {
  E.surface.disabled = true;
  say('Reading folder and file names…', true);
  try {
    const res = await api('/api/surface', {});
    const parts = res.parts || [];
    say('');
    if (!parts.length) { say('the read came back with nothing to name'); return; }

    const list = sec('Proposed, and not written yet', null);
    const boxes = [];
    for (const p of parts) {
      const tick = Object.assign(el('input'), { type: 'checkbox', checked: true, value: p.name });
      boxes.push(tick);
      const seen = (p.seenIn || []).length ? `seen in ${p.seenIn.join(', ')}` : '';
      const row = linkRow(null, p.name, [p.why, seen]);
      row.insertBefore(tick, row.firstChild);
      row.addEventListener('click', ev => { if (ev.target !== tick) tick.checked = !tick.checked; });
      list.appendChild(row);
    }

    const foot = document.createDocumentFragment();
    foot.appendChild(el('span', 'grow',
      `One model call${res.cost ? ` · ${res.cost}` : ''}. Nothing is written until you press.`));
    // The read proposes; nothing reaches the map until this is pressed.
    const go = button('accept', 'Add the ticked ones', async () => {
      go.disabled = true;
      try {
        const done = await api('/api/surface/accept', { names: boxes.filter(b => b.checked).map(b => b.value) });
        closeSheet();
        await loadLevel(null);
        const skipped = (done.skipped || []).map(s => `${s.name} — ${s.why}`);
        say(`${(done.created || []).length} added${skipped.length ? `. Left alone: ${skipped.join('; ')}` : ''}`);
      } catch (err) { say(err.message); go.disabled = false; }
    });
    foot.appendChild(go);
    openSheet('Name the big parts', list, foot);
  } catch (err) {
    say(err.message);
  } finally {
    E.surface.disabled = false;
  }
}

// A lookup that is not an exact hit stops and asks. There is deliberately no
// path through here that picks one for the person: a quiet second node splits
// the map in half and nobody notices until it is dear to fix.
function askChoice(res) {
  const s = sec(`Which one did you mean by “${res.asked}”?`, el('p', null,
    'More than one thing on the map answers to that name. Picking the wrong one is cheap to undo; a second node made by accident is not.'));
  for (const c of res.candidates || []) {
    const row = linkRow('›', c.name, c.key);
    row.addEventListener('click', () => { S.ask.choices[String(res.at)] = c.key; closeSheet(); runAsk(); });
    s.appendChild(row);
  }
  openSheet('Say which one', s, el('span', 'grow', 'Nothing has been written. The walk stopped here.'));
}

async function runAsk() {
  E.askGo.disabled = true;
  say('Walking down to it…', true);
  try {
    const { text, path, intent, choices } = S.ask;
    const res = await api('/api/ask', { text, path, intent, choices });
    if (res.heard) { S.ask.path = res.heard.path; S.ask.intent = res.heard.intent; }
    say('');
    if (res.needsChoice) { askChoice(res); return; }

    const keys = res.keys || [], target = keys[keys.length - 1];
    const closed = (res.neighbours || []).map(n => n.name);
    const walked = ((res.heard && res.heard.path) || res.path || []).join(' › ');
    const lines = [res.already
      ? `${walked} was already read, so nothing was spent on it again.`
      : `Read ${walked}${(res.deeper || []).length ? ` and ${res.deeper.length} below it` : ''}.`];
    if (closed.length) lines.push(`Named but left closed: ${closed.join(', ')}.`);
    if ((res.created || []).length) lines.push(`${res.created.length} named on the way down.`);
    if ((res.problems || []).length) lines.push(`${res.problems.length} claims did not check out.`);
    if (res.cost) lines.push(res.cost);
    E.askHint.textContent = lines.join(' ');

    S.ask.choices = {};
    S.ask.path = null;
    const inside = (res.children || []).length > 0;
    await loadLevel(inside ? target : parentKey(target));
    if (!inside && target) select(target);
  } catch (err) {
    say(err.message);
  } finally {
    E.askGo.disabled = false;
  }
}

async function explore(key, btn) {
  btn.disabled = true;
  say('Reading the code under it…', true);
  try {
    const res = await api('/api/map/explore', { key, depth: 2 });
    const read = (res.explored || []).length || 1;
    await loadLevel(S.parent);
    select(key);
    // Said after the level has reloaded, which clears the status on its way out.
    say(`${read} read from the code${res.cost ? ` · ${res.cost}` : ''}`);
  } catch (err) {
    say(err.message);
    btn.disabled = false;
  }
}

async function rebuild() {
  E.rebuild.disabled = true;
  say('Checking what moved…', true);
  try {
    const res = await api('/api/map/rebuild', {});
    await loadLevel(S.parent);
    say(res.text || `${(res.untouched || []).length} left exactly as they were.`);
  } catch (err) {
    say(err.message);
  } finally {
    E.rebuild.disabled = false;
  }
}

// ------------------------------------------------------------------ dragging

let savePending = null;

// Where a box sits is one person's habit, so it is saved quietly and behind the
// gesture rather than on every pixel of it.
function savePositions() {
  clearTimeout(savePending);
  savePending = setTimeout(() => {
    api('/api/map/positions', { pos: S.saved }).catch(err => say(err.message));
  }, 500);
}

const boxAt = ev => (ev.target.closest ? ev.target.closest('.mbox') : null);

function onMouseMove(ev) {
  if (!mapOn()) return;
  if (S.drag) {
    const now = toWorld(ev);
    const x = S.drag.at.x + (now.x - S.drag.from.x), y = S.drag.at.y + (now.y - S.drag.from.y);
    if (Math.abs(x - S.drag.at.x) + Math.abs(y - S.drag.at.y) > 2) S.drag.moved = true;
    S.pos.set(S.drag.key, { x, y });
    S.drag.g.setAttribute('transform', `translate(${x} ${y})`);
    drawEdges();
  } else if (S.pan) {
    S.view.x = S.pan.view.x + (ev.clientX - S.pan.x);
    S.view.y = S.pan.view.y + (ev.clientY - S.pan.y);
    applyView();
  }
}

function onMouseUp() {
  if (!mapOn()) return;
  if (S.drag) {
    const { key, moved } = S.drag;
    S.drag = null;
    if (!moved) select(key);
    else { S.saved[key] = S.pos.get(key); savePositions(); }
  }
  S.pan = null;
}

// ------------------------------------------------------------------ wiring

function showTab(map) {
  E.tabMap.classList.toggle('on', map);
  E.tabCode.classList.toggle('on', !map);
  E.mapPane.classList.toggle('on', map);
  E.codePane.classList.toggle('on', !map);
}

E.tabMap.addEventListener('click', () => showTab(true));
E.tabCode.addEventListener('click', () => { closeSheet(); showTab(false); });

E.stage.addEventListener('mousedown', ev => {
  // The trail, the zoom and the status sit over the canvas; a press on one of
  // them is a press on it, not the start of a pan.
  if (ev.button !== 0 || !ev.target.closest('svg')) return;
  const g = boxAt(ev);
  if (g) S.drag = { key: g.dataset.key, g, from: toWorld(ev), at: { ...S.pos.get(g.dataset.key) }, moved: false };
  else S.pan = { x: ev.clientX, y: ev.clientY, view: { ...S.view } };
});
E.stage.addEventListener('dblclick', ev => {
  const g = boxAt(ev);
  const card = g && S.nodes.find(c => c.key === g.dataset.key);
  if (card && card.hasChildren) openNode(card.key);
});
E.stage.addEventListener('wheel', ev => {
  ev.preventDefault();
  zoomTo(S.view.k * (ev.deltaY < 0 ? 1.1 : 1 / 1.1), { x: ev.clientX, y: ev.clientY });
}, { passive: false });

window.addEventListener('mousemove', onMouseMove);
window.addEventListener('mouseup', onMouseUp);
window.addEventListener('keydown', ev => {
  if (!mapOn() || ev.key !== 'Escape') return;
  if (!E.sheet.hidden) closeSheet();
  else if (S.sel) select(null);
});

E.zoomIn.addEventListener('click', () => zoomTo(S.view.k * 1.2));
E.zoomOut.addEventListener('click', () => zoomTo(S.view.k / 1.2));
E.zoomFit.addEventListener('click', fitView);
E.sheetClose.addEventListener('click', closeSheet);
E.scrim.addEventListener('click', closeSheet);
E.rebuild.addEventListener('click', rebuild);
E.surface.addEventListener('click', surface);
E.askGo.addEventListener('click', () => {
  const text = E.ask.value.trim();
  if (!text) return;
  S.ask = { text, path: null, intent: 'explore', choices: {} };
  E.askHint.textContent = '';
  runAsk();
});

// ------------------------------------------------------------------ opening

(async () => {
  try { S.saved = (await api('/api/map/positions')).pos || {}; } catch { S.saved = {}; }
  await loadLevel(null);
})();
