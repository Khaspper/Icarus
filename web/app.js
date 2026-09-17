// The canvas. Draws the map, opens boxes, holds the plan, presses build.

const $ = s => document.querySelector(s);
const svgNS = 'http://www.w3.org/2000/svg';

const SIZE = {
  group:   { w: 210, h: 68, title: 25, sub: 41, meta: 57 },
  file:    { w: 198, h: 64, title: 24, sub: 39, meta: 54 },
  symbol:  { w: 186, h: 52, title: 23, sub: 38, meta: 45 },
  planned: { w: 232, h: 86, title: 26, sub: 43, meta: 74 },
};

const state = {
  repo: null,
  open: new Set(),
  boxes: [],
  edges: [],
  plan: { boxes: [], edges: [] },
  meaning: {},           // box id -> written-up meaning
  pos: new Map(),        // box id -> {x,y}
  sel: null,
  tool: 'select',
  cam: { x: 0, y: 0, k: 1 },
  linkFrom: null,
  heldBack: 0,
  hiddenEdges: 0,
  build: null,
};

// ---------------------------------------------------------------- talking to the server

async function api(path, body) {
  const res = await fetch('/api' + path, body ? {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  } : undefined);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || res.statusText);
  }
  return res.json();
}

function busy(msg) {
  const el = $('#status');
  if (!msg) { el.classList.remove('show'); return; }
  el.innerHTML = '<span class="spin"></span>' + esc(msg);
  el.classList.add('show');
}
function said(msg, ms = 2400) {
  const el = $('#status');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(said.t);
  said.t = setTimeout(() => el.classList.remove('show'), ms);
}

// ---------------------------------------------------------------- loading

async function boot() {
  const repo = await api('/repo');
  state.repo = repo;
  $('#repoName').textContent = repo.name;
  const cov = $('#coverage');
  cov.textContent = repo.coverage.text;
  cov.classList.toggle('partial', !repo.coverage.whole);
  cov.title = repo.coverage.detail;

  const saved = await api('/plan');
  state.plan = saved.plan || { boxes: [], edges: [] };
  state.meaning = saved.meaning || {};
  $('#workspaceNotes').value = saved.notes || '';

  await refresh(true);
}

async function refresh(fit = false) {
  const data = await api('/map?open=' + encodeURIComponent([...state.open].join('|')));
  state.boxes = data.boxes;
  state.edges = data.edges;
  state.heldBack = data.heldBack;
  state.hiddenEdges = data.hiddenEdges;
  state.hiddenGroups = data.hiddenGroups || 0;
  layout();
  draw();
  drawOutline();
  if (fit) fitView();
  const held = $('#held');
  const notes = [];
  if (state.heldBack) notes.push(`${state.heldBack} more files in here are not drawn`);
  if (state.hiddenGroups) notes.push(`${state.hiddenGroups} parts of the repo that this does not touch are hidden`);
  if (notes.length) {
    held.hidden = false;
    held.textContent = notes.join(' \u00b7 ') + '.';
  } else held.hidden = true;
}

// ---------------------------------------------------------------- layout
// Left to right by what depends on what, tidied by where a box's neighbours sit.

function layout() {
  const all = [...state.boxes, ...state.plan.boxes];
  const byId = new Map(all.map(b => [b.id, b]));
  let edges = [...state.edges, ...state.plan.edges].filter(e => byId.has(e.from) && byId.has(e.to));

  // Two boxes that lean on each other would otherwise push the picture into a
  // long thin chain. Keep the heavier direction of each such pair and drop the
  // other, so the drawing still reads left to right.
  const pairWeight = new Map(edges.map(e => [e.from + '>' + e.to, e.weight || 1]));
  edges = edges.filter(e => {
    const back = pairWeight.get(e.to + '>' + e.from);
    if (back === undefined) return true;
    const mine = e.weight || 1;
    return mine > back || (mine === back && e.from < e.to);
  });

  // Layer = how far down the chain a box sits.
  const layer = new Map(all.map(b => [b.id, 0]));
  for (let pass = 0; pass < 6; pass++) {
    let moved = false;
    for (const e of edges) {
      if (e.from === e.to) continue;
      const want = layer.get(e.from) + 1;
      if (layer.get(e.to) < want) { layer.set(e.to, want); moved = true; }
    }
    if (!moved) break;
  }

  const cols = new Map();
  for (const b of all) {
    const l = Math.min(layer.get(b.id) || 0, 6);
    if (!cols.has(l)) cols.set(l, []);
    cols.get(l).push(b);
  }

  // Order inside a column by the average height of its neighbours.
  const order = new Map(all.map((b, i) => [b.id, i]));
  for (let pass = 0; pass < 4; pass++) {
    for (const [, list] of [...cols].sort((a, b) => a[0] - b[0])) {
      for (const b of list) {
        const near = edges.filter(e => e.from === b.id || e.to === b.id)
          .map(e => order.get(e.from === b.id ? e.to : e.from))
          .filter(v => v !== undefined);
        if (near.length) order.set(b.id, near.reduce((a, c) => a + c, 0) / near.length);
      }
      list.sort((a, b) => order.get(a.id) - order.get(b.id));
      list.forEach((b, i) => order.set(b.id, i));
    }
  }

  // A column with a dozen boxes in it makes a tall thin picture that has to be
  // zoomed out to fit, which is how these maps become unreadable. Let a tall
  // column wrap into two or three side by side instead.
  const COL_GAP = 92, ROW_GAP = 24, SUB_GAP = 18, TALLEST = 7;
  let x = 0;
  for (const l of [...cols.keys()].sort((a, b) => a - b)) {
    const list = cols.get(l);
    const lanes = Math.ceil(list.length / TALLEST);
    const perLane = Math.ceil(list.length / lanes);
    let laneX = x, widestColumn = 0;

    for (let lane = 0; lane < lanes; lane++) {
      const slice = list.slice(lane * perLane, (lane + 1) * perLane);
      if (!slice.length) continue;
      const widest = Math.max(...slice.map(b => sizeOf(b).w));
      let y = 0;
      for (const b of slice) {
        const s = sizeOf(b);
        if (!b.pinned) state.pos.set(b.id, { x: laneX + (widest - s.w) / 2, y });
        else if (!state.pos.has(b.id)) state.pos.set(b.id, { x: laneX, y });
        y += s.h + ROW_GAP;
      }
      const height = y - ROW_GAP;
      for (const b of slice) if (!b.pinned) state.pos.get(b.id).y -= height / 2;
      laneX += widest + SUB_GAP;
      widestColumn = laneX - x;
    }
    x += widestColumn - SUB_GAP + COL_GAP;
  }
}

function sizeOf(b) {
  const s = SIZE[b.level === 'planned' ? 'planned' : b.level] || SIZE.file;
  return { ...s };
}

// ---------------------------------------------------------------- drawing

function draw() {
  const boxLayer = $('#boxLayer'), edgeLayer = $('#edgeLayer');
  boxLayer.textContent = ''; edgeLayer.textContent = '';

  const all = [...state.boxes, ...state.plan.boxes];
  const byId = new Map(all.map(b => [b.id, b]));

  const maxW = Math.max(1, ...state.edges.map(e => e.weight || 1));
  for (const e of [...state.edges, ...state.plan.edges]) {
    const a = byId.get(e.from), b = byId.get(e.to);
    if (!a || !b) continue;
    edgeLayer.appendChild(edgeShape(a, b, e, maxW));
  }
  for (const b of all) boxLayer.appendChild(boxShape(b));
  drawNotes();
  applyCam();
}

function anchors(a, b) {
  const pa = state.pos.get(a.id), pb = state.pos.get(b.id);
  const sa = sizeOf(a), sb = sizeOf(b);
  const ca = { x: pa.x + sa.w / 2, y: pa.y + sa.h / 2 };
  const cb = { x: pb.x + sb.w / 2, y: pb.y + sb.h / 2 };
  const horizontal = Math.abs(cb.x - ca.x) > Math.abs(cb.y - ca.y);
  if (horizontal) {
    const right = cb.x > ca.x;
    return [
      { x: right ? pa.x + sa.w : pa.x, y: ca.y },
      { x: right ? pb.x : pb.x + sb.w, y: cb.y },
      true,
    ];
  }
  const down = cb.y > ca.y;
  return [
    { x: ca.x, y: down ? pa.y + sa.h : pa.y },
    { x: cb.x, y: down ? pb.y : pb.y + sb.h },
    false,
  ];
}

function edgeShape(a, b, e, maxW) {
  const g = el('g');
  const [p1, p2, horiz] = anchors(a, b);
  const path = el('path');
  const d = horiz
    ? `M${p1.x} ${p1.y} C${(p1.x + p2.x) / 2} ${p1.y}, ${(p1.x + p2.x) / 2} ${p2.y}, ${p2.x} ${p2.y}`
    : `M${p1.x} ${p1.y} C${p1.x} ${(p1.y + p2.y) / 2}, ${p2.x} ${(p1.y + p2.y) / 2}, ${p2.x} ${p2.y}`;
  path.setAttribute('d', d);
  let cls = 'edge';
  if (e.planned) cls += ' planned';
  else if ((e.weight || 1) / maxW > 0.35) cls += ' strong';
  else if ((e.weight || 1) <= 2) cls += ' dim';
  if (state.sel && (e.from === state.sel || e.to === state.sel)) cls += ' hot';
  path.setAttribute('class', cls);
  g.appendChild(path);

  const label = e.note || e.relation || '';
  const showLabel = e.planned || (state.sel && (e.from === state.sel || e.to === state.sel));
  if (label && showLabel) {
    const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
    const lines = wrap(label, 22).slice(0, 2);
    const bg = el('rect');
    const w = Math.max(...lines.map(l => l.length)) * 5.6 + 10;
    bg.setAttribute('class', 'edge-label-bg');
    bg.setAttribute('x', mx - w / 2); bg.setAttribute('y', my - 8 * lines.length);
    bg.setAttribute('width', w); bg.setAttribute('height', 13 * lines.length + 3);
    g.appendChild(bg);
    lines.forEach((line, i) => {
      const t = el('text');
      t.setAttribute('class', e.planned ? 'edge-note' : 'edge-label');
      t.setAttribute('x', mx); t.setAttribute('y', my + 2 - (lines.length - 1) * 6 + i * 12);
      t.setAttribute('text-anchor', 'middle');
      t.textContent = line;
      g.appendChild(t);
    });
  }
  if (!e.planned && e.weight > 1 && showLabel) {
    const t = el('text');
    t.setAttribute('class', 'edge-label');
    t.setAttribute('x', (p1.x + p2.x) / 2); t.setAttribute('y', (p1.y + p2.y) / 2 + 16);
    t.setAttribute('text-anchor', 'middle');
    t.textContent = `${e.weight}×`;
    g.appendChild(t);
  }
  return g;
}

function boxShape(b) {
  const p = state.pos.get(b.id) || { x: 0, y: 0 };
  const s = sizeOf(b);
  const m = state.meaning[b.id];
  const filled = !!m;

  const g = el('g');
  let cls = `box k-${b.level}`;
  if (!filled && b.level !== 'planned') cls += ' grey';
  if (b.id === state.sel) cls += ' sel';
  if (b.level === 'planned' && b.built) cls += ' built';
  if (b.mismatch) cls += ' mismatch';
  g.setAttribute('class', cls);
  g.setAttribute('transform', `translate(${p.x} ${p.y})`);
  g.dataset.id = b.id;

  const shell = el('rect');
  shell.setAttribute('class', 'shell');
  shell.setAttribute('width', s.w); shell.setAttribute('height', s.h);
  shell.setAttribute('rx', 10);
  g.appendChild(shell);

  const accent = el('rect');
  accent.setAttribute('class', 'accent');
  accent.setAttribute('x', 0); accent.setAttribute('y', 12);
  accent.setAttribute('width', 3); accent.setAttribute('height', s.h - 24);
  accent.setAttribute('rx', 2);
  g.appendChild(accent);

  const title = el('text');
  title.setAttribute('class', 'title');
  title.setAttribute('x', 14); title.setAttribute('y', s.title);
  title.textContent = clipToWidth(b.title, s.w - 76, 13);
  g.appendChild(title);

  const sub = el('text');
  sub.setAttribute('class', 'sub');
  sub.setAttribute('x', 14); sub.setAttribute('y', s.sub);
  sub.textContent = clipToWidth(subtitleFor(b, m), s.w - 26, 10.5);
  g.appendChild(sub);

  const meta = el('text');
  meta.setAttribute('class', 'meta');
  meta.setAttribute('x', 14); meta.setAttribute('y', s.meta);
  meta.textContent = clipToWidth(metaFor(b), s.w - 26, 10.5);
  g.appendChild(meta);

  const chip = chipFor(b, filled);
  if (chip) {
    const cw = chip.text.length * 5.4 + 12;
    const cg = el('g');
    cg.setAttribute('class', 'chip-' + chip.kind);
    cg.setAttribute('transform', `translate(${s.w - cw - 10} 12)`);
    const bg = el('rect');
    bg.setAttribute('class', 'pill-bg');
    bg.setAttribute('width', cw); bg.setAttribute('height', 16); bg.setAttribute('rx', 5);
    cg.appendChild(bg);
    const tx = el('text');
    tx.setAttribute('class', 'pill');
    tx.setAttribute('x', cw / 2); tx.setAttribute('y', 11.5);
    tx.setAttribute('text-anchor', 'middle');
    tx.textContent = chip.text;
    cg.appendChild(tx);
    g.appendChild(cg);
  }
  return g;
}

function subtitleFor(b, m) {
  if (m && m.whatItDoes) return m.whatItDoes;
  if (b.level === 'planned') return b.whatItDoes || 'does not exist yet';
  if (b.level === 'file') return shortFolder(b.path);
  return b.subtitle || '';
}

// A whole path does not fit in a box and reads as noise anyway. Show the two
// folders it sits in, with a leading ellipsis when there is more above them.
function shortFolder(p) {
  const parts = String(p || '').split('/');
  parts.pop();
  if (parts.length <= 2) return parts.join('/');
  return '\u2026/' + parts.slice(-2).join('/');
}
function metaFor(b) {
  if (b.level === 'group') return `${b.files} files · ${b.count} things`;
  if (b.level === 'file') return `${b.count} things · ${b.path.split('/').slice(-2, -1)[0] || ''}`;
  if (b.level === 'symbol') return b.startLine ? `line ${b.startLine}` : '';
  if (b.level === 'planned') return b.landedAt ? b.landedAt : 'planned';
  return '';
}
function chipFor(b, filled) {
  if (b.level === 'planned') {
    if (b.mismatch) return { kind: 'bad', text: 'does not match' };
    if (b.built) return { kind: 'built', text: 'built' };
    return { kind: 'plan', text: 'planned' };
  }
  return filled ? { kind: 'filled', text: 'written up' } : { kind: 'grey', text: 'not read' };
}

function el(name) { return document.createElementNS(svgNS, name); }
// Rough width of a string at a given font size, so text stops before the edge
// of its box instead of running past it.
function clipToWidth(str, px, size) {
  str = String(str || '');
  const per = size * 0.54;
  const max = Math.floor(px / per);
  return str.length > max ? str.slice(0, Math.max(1, max - 1)) + '…' : str;
}
function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function wrap(s, n) {
  const words = String(s).split(/\s+/); const out = []; let line = '';
  for (const w of words) {
    if ((line + ' ' + w).trim().length > n) { if (line) out.push(line); line = w; }
    else line = (line + ' ' + w).trim();
  }
  if (line) out.push(line);
  return out;
}

// ---------------------------------------------------------------- camera

function applyCam() {
  const { x, y, k } = state.cam;
  $('#world').setAttribute('transform', `translate(${x} ${y}) scale(${k})`);
  $('#zoomLevel').textContent = Math.round(k * 100) + '%';
}
function fitView() {
  const all = [...state.boxes, ...state.plan.boxes];
  if (!all.length) return;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const b of all) {
    const p = state.pos.get(b.id); if (!p) continue;
    const s = sizeOf(b);
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x + s.w); y1 = Math.max(y1, p.y + s.h);
  }
  const stage = $('#stage').getBoundingClientRect();
  const pad = 70;
  const k = Math.min((stage.width - pad * 2) / (x1 - x0), (stage.height - pad * 2) / (y1 - y0), 1.25);
  state.cam.k = Math.max(0.12, k);
  state.cam.x = stage.width / 2 - ((x0 + x1) / 2) * state.cam.k;
  state.cam.y = stage.height / 2 - ((y0 + y1) / 2) * state.cam.k;
  applyCam();
}
function toWorld(cx, cy) {
  const r = $('#stage').getBoundingClientRect();
  return { x: (cx - r.left - state.cam.x) / state.cam.k, y: (cy - r.top - state.cam.y) / state.cam.k };
}

// ---------------------------------------------------------------- outline

function drawOutline() {
  const out = $('#outline');
  out.textContent = '';

  const groups = state.boxes.filter(b => b.level === 'group')
    .sort((a, b) => a.title.localeCompare(b.title));
  const openIds = [...state.open].filter(id => id.startsWith('group:'));

  // An open group is no longer in the box list, so rebuild its row from its id
  // and hang the files that came back underneath it.
  const rows = [];
  for (const g of groups) rows.push({ id: g.id, name: g.title, n: g.count, lvl: 1 });
  for (const id of openIds) {
    rows.push({ id, name: prettyGroupName(id), n: null, open: true, lvl: 1 });
  }
  rows.sort((a, b) => a.name.localeCompare(b.name));

  const withChildren = [];
  for (const r of rows) {
    withChildren.push(r);
    if (!r.open) continue;
    const kids = state.boxes.filter(b => b.level === 'file' && b.parent === r.id)
      .sort((a, b) => a.title.localeCompare(b.title));
    for (const f of kids) {
      withChildren.push({ id: f.id, name: f.title, n: f.count, lvl: 2, open: state.open.has(f.id) });
    }
  }

  for (const r of withChildren) {
    const d = document.createElement('div');
    d.className = 'item' + (r.lvl === 2 ? ' lvl2' : '') + (state.sel === r.id ? ' on' : '');
    const written = state.meaning[r.id] ? ' <span class="wrote">\u2713</span>' : '';
    d.innerHTML = `<span class="tw">${r.open ? '\u25be' : '\u25b8'}</span>` +
      `<span class="nm">${esc(r.name)}</span>${written}` +
      (r.n != null ? `<span class="n">${r.n}</span>` : '');
    d.onclick = () => toggleOpen(r.id);
    out.appendChild(d);
  }
}

function prettyGroupName(id) {
  const key = id.slice(6);
  const last = key.replace(/\/\.$/, '').split('/').filter(Boolean).pop() || key;
  return last.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

async function toggleOpen(id) {
  if (state.open.has(id)) state.open.delete(id); else state.open.add(id);
  // Opening a box changes how much there is to look at, so frame it again.
  for (const b of [...state.boxes, ...state.plan.boxes]) b.pinned = false;
  state.pos.clear();
  await refresh(true);
}

// ---------------------------------------------------------------- inspector

function showInspector() {
  const id = state.sel;
  const empty = $('#inspectorEmpty'), body = $('#inspectorBody');
  if (!id) { empty.hidden = false; body.hidden = true; return; }
  empty.hidden = true; body.hidden = false;

  const b = [...state.boxes, ...state.plan.boxes].find(x => x.id === id);
  if (!b) { empty.hidden = false; body.hidden = true; return; }
  const m = state.meaning[id];

  const parts = [];
  parts.push(`<div class="ins-head">
    <div class="ins-kind">${b.level === 'planned' ? 'Planned box' : b.level}</div>
    <div class="ins-title">${esc(b.title)}
      ${b.level === 'planned'
        ? (b.built ? '<span class="tag built">built</span>' : '<span class="tag plan">planned</span>')
        : (m ? '<span class="tag filled">written up</span>' : '<span class="tag grey">not read</span>')}
    </div>
    ${b.path ? `<div class="ins-path">${esc(b.path)}${b.startLine ? ':' + b.startLine : ''}</div>` : ''}
    ${b.folder ? `<div class="ins-path">${esc(b.folder)}/</div>` : ''}
  </div>`);

  if (b.mismatch) {
    parts.push(`<div class="sec"><h4>The code does not match this box</h4><p>${esc(b.mismatch)}</p>
      <p class="muted">The code wins. This box is wrong until someone changes one of them.</p></div>`);
  }

  if (b.level === 'planned') {
    parts.push(plannedForm(b));
  } else if (m) {
    parts.push(meaningSections(m));
  } else {
    parts.push(`<div class="sec"><p class="muted">Nobody has written down what this is for.
      Everything on this box so far came from reading the code's shape, not its meaning.</p></div>`);
  }

  // what it touches
  const touching = [...state.edges, ...state.plan.edges]
    .filter(e => e.from === id || e.to === id)
    .sort((a, b2) => (b2.weight || 1) - (a.weight || 1)).slice(0, 12);
  if (touching.length) {
    parts.push(`<div class="sec"><h4>What it touches</h4>` + touching.map(e => {
      const other = e.from === id ? e.to : e.from;
      const ob = [...state.boxes, ...state.plan.boxes].find(x => x.id === other);
      const dir = e.from === id ? '→' : '←';
      return `<div class="link-row" data-go="${esc(other)}">
        <span class="rel">${dir} ${esc(e.note || e.relation || '')}</span>
        <span class="nm">${esc(ob ? ob.title : other)}</span>
        ${e.weight > 1 ? `<span class="w">${e.weight}×</span>` : ''}
      </div>`;
    }).join('') + `</div>`);
  }

  parts.push(`<div class="act">${actionsFor(b, m)}</div>`);
  $('#inspectorBody').innerHTML = parts.join('');
  wireInspector(b);
}

function meaningSections(m) {
  const list = (title, items) => items && items.length
    ? `<div class="sec"><h4>${title}</h4><ul>${items.map(i => `<li>${esc(i)}</li>`).join('')}</ul></div>` : '';
  const para = (title, text) => text
    ? `<div class="sec"><h4>${title}</h4><p>${esc(text)}</p></div>` : '';
  return [
    para('What it does', m.whatItDoes),
    list('What goes in', m.dataIn),
    list('What it decides', m.manipulation),
    list('What comes out', m.dataOut),
    list('Tables it touches', m.tablesTouched),
    list('Functions it calls', m.functionsCalled),
    m.checked ? `<div class="sec"><h4>Checked against the repo</h4>${m.checked.map(c =>
      `<div class="check"><span class="${c.ok ? 'ok' : 'no'}">${c.ok ? '✓' : '✗'}</span><span>${esc(c.what)}</span></div>`
    ).join('')}</div>` : '',
  ].join('');
}

function plannedForm(b) {
  return `<div class="sec">
    <div class="field"><label>What should it do</label>
      <textarea id="pWhat" rows="3" placeholder="One or two plain sentences.">${esc(b.whatItDoes || '')}</textarea></div>
    <div class="field"><label>Decisions it makes</label>
      <textarea id="pDecide" rows="3" placeholder="One per line.">${esc((b.decisions || []).join('\n'))}</textarea></div>
    <div class="field"><label>Where the code should go</label>
      <input id="pWhere" placeholder="a path, or leave blank" value="${esc(b.where || '')}"></div>
  </div>`;
}

function actionsFor(b, m) {
  if (b.level === 'planned') {
    const ready = (b.whatItDoes || '').trim().length > 0;
    return `
      <button class="secondary" id="savePlan">Save this box</button>
      <button class="primary build" id="doBuild" ${ready ? '' : 'disabled'}>Build this</button>
      <div class="hint">${ready
        ? 'Sends this box, its decisions, and the note on every arrow touching it.'
        : 'Say what it should do first.'}</div>
      <button class="secondary" id="delPlan">Delete</button>`;
  }
  if (b.level === 'group') {
    return `<button class="secondary" id="openBox">${state.open.has(b.id) ? 'Close' : 'Open'} this</button>
      <button class="primary" id="doFill">${m ? 'Write it up again' : 'Fill in with Claude'}</button>
      <div class="hint">Reads only this part. ${b.files} files.</div>`;
  }
  if (b.level === 'file') {
    return `<button class="secondary" id="openBox">${state.open.has(b.id) ? 'Close' : 'Open'} this</button>
      <button class="primary" id="doFill">${m ? 'Write it up again' : 'Fill in with Claude'}</button>
      <div class="hint">Reads one file.</div>`;
  }
  return `<button class="primary" id="doFill">${m ? 'Write it up again' : 'Fill in with Claude'}</button>
    <div class="hint">Reads the lines this function sits on.</div>`;
}

function wireInspector(b) {
  const on = (sel, fn) => { const e = $(sel); if (e) e.onclick = fn; };
  on('#openBox', () => toggleOpen(b.id));
  on('#doFill', () => fillIn(b));
  on('#savePlan', () => savePlanned(b));
  on('#doBuild', () => runBuild(b));
  on('#delPlan', () => {
    state.plan.boxes = state.plan.boxes.filter(x => x.id !== b.id);
    state.plan.edges = state.plan.edges.filter(e => e.from !== b.id && e.to !== b.id);
    state.sel = null; persistPlan(); layout(); draw(); showInspector();
  });
  for (const row of document.querySelectorAll('[data-go]')) {
    row.onclick = () => { state.sel = row.dataset.go; draw(); showInspector(); drawOutline(); };
  }
}

function savePlanned(b) {
  b.whatItDoes = ($('#pWhat') || {}).value || '';
  b.decisions = (($('#pDecide') || {}).value || '').split('\n').map(s => s.trim()).filter(Boolean);
  b.where = ($('#pWhere') || {}).value || '';
  persistPlan(); draw(); said('Saved.');
}

async function persistPlan() {
  await api('/plan', { plan: state.plan, meaning: state.meaning, notes: $('#workspaceNotes').value });
}

// ---------------------------------------------------------------- filling in

async function fillIn(b) {
  busy('Reading ' + b.title + '…');
  try {
    const res = await api('/fill', { box: b });
    state.meaning[b.id] = res.meaning;
    await persistPlan();
    draw(); showInspector();
    busy(null);
    said(res.meaning.checked && res.meaning.checked.some(c => !c.ok)
      ? 'Written up, but some of it did not check out.'
      : `Written up. ${res.cost || ''}`.trim());
  } catch (err) {
    busy(null);
    said('Could not write it up: ' + err.message, 6000);
  }
}

// ---------------------------------------------------------------- building

async function runBuild(b) {
  busy('Building … this takes a minute');
  openSheet('Build: ' + b.title, '<div class="runlog">Working…</div>', '');
  try {
    const res = await api('/build', { box: b, plan: state.plan });
    state.build = res;
    busy(null);
    renderBuild(b, res);
  } catch (err) {
    busy(null);
    openSheet('Build failed', `<div class="runlog">${esc(err.message)}</div>`,
      `<button class="ghost" onclick="document.getElementById('sheetClose').click()">Close</button>`);
  }
}

function renderBuild(b, res) {
  const body = `
    <div class="diff">${renderDiff(res.diff)}</div>
    ${res.tests ? `<div class="brief"><h4>Tests</h4><pre>${esc(res.tests)}</pre></div>` : ''}
    ${res.downstream && res.downstream.length ? `<div class="brief"><h4>Boxes downstream that might be affected</h4><pre>${esc(res.downstream.join('\n'))}</pre></div>` : ''}
    <div class="brief"><h4>What was sent</h4><pre>${esc(res.brief)}</pre></div>`;
  const foot = `<span class="grow">${esc(res.summary || '')}</span>
    <button class="reject" id="rejectBuild">Throw it away</button>
    <button class="accept" id="acceptBuild">Accept</button>`;
  openSheet('Build: ' + b.title, body, foot);
  $('#acceptBuild').onclick = () => acceptBuild(b);
  $('#rejectBuild').onclick = () => rejectBuild(b);
}

function renderDiff(diff) {
  if (!diff || !diff.trim()) return '<div class="runlog">No change came back.</div>';
  const out = [];
  let oldN = 0, newN = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git')) {
      const m = /b\/(.+)$/.exec(line);
      out.push(`<div class="fileh">${esc(m ? m[1] : line)}</div>`);
    } else if (/^(index|---|\+\+\+|new file|deleted file|similarity|rename) /.test(line)) {
      continue;
    } else if (line.startsWith('@@')) {
      const m = /@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
      if (m) { oldN = +m[1]; newN = +m[2]; }
      out.push(`<div class="ln hunk"><span class="no"></span><span class="tx">${esc(line)}</span></div>`);
    } else if (line.startsWith('+')) {
      out.push(`<div class="ln add"><span class="no">${newN++}</span><span class="tx">${esc(line.slice(1))}</span></div>`);
    } else if (line.startsWith('-')) {
      out.push(`<div class="ln del"><span class="no">${oldN++}</span><span class="tx">${esc(line.slice(1))}</span></div>`);
    } else {
      out.push(`<div class="ln"><span class="no">${newN++}</span><span class="tx">${esc(line.slice(1))}</span></div>`);
      oldN++;
    }
  }
  return out.join('');
}

async function acceptBuild(b) {
  busy('Reading back what was written…');
  try {
    const res = await api('/accept', { buildId: state.build.id, box: b });
    b.built = true;
    b.landedAt = res.landedAt || '';
    b.mismatch = res.mismatch || null;
    if (res.meaning) state.meaning[b.id] = res.meaning;
    await persistPlan();
    closeSheet(); busy(null); layout(); draw(); showInspector();
    said(res.mismatch ? 'Accepted, but the code does not match the box.' : 'Accepted. The box is real now.', 5000);
  } catch (err) { busy(null); said('Could not accept: ' + err.message, 6000); }
}

async function rejectBuild(b) {
  busy('Putting it back…');
  try {
    await api('/reject', { buildId: state.build.id });
    closeSheet(); busy(null); said('Thrown away. Nothing changed.');
  } catch (err) { busy(null); said('Could not undo: ' + err.message, 6000); }
}

function openSheet(title, body, foot) {
  $('#sheetTitle').textContent = title;
  $('#sheetBody').innerHTML = body;
  $('#sheetFoot').innerHTML = foot;
  $('#sheet').hidden = false; $('#scrim').hidden = false;
}
function closeSheet() { $('#sheet').hidden = true; $('#scrim').hidden = true; }

// ---------------------------------------------------------------- input

let drag = null;

$('#stage').addEventListener('mousedown', ev => {
  const boxEl = ev.target.closest('.box');
  if (state.tool === 'pan' || ev.button === 1 || ev.altKey) {
    drag = { kind: 'cam', x: ev.clientX, y: ev.clientY, cx: state.cam.x, cy: state.cam.y };
    $('#stage').classList.add('panning');
    return;
  }
  if (boxEl) {
    const id = boxEl.dataset.id;
    if (state.tool === 'arrow') {
      if (!state.linkFrom) { state.linkFrom = id; said('Now click where it should go.'); }
      else if (state.linkFrom !== id) { addPlannedEdge(state.linkFrom, id); state.linkFrom = null; }
      return;
    }
    state.sel = id; draw(); showInspector(); drawOutline();
    const p = state.pos.get(id);
    drag = { kind: 'box', id, x: ev.clientX, y: ev.clientY, bx: p.x, by: p.y, moved: false };
    return;
  }
  if (state.tool === 'plan') { addPlannedBox(toWorld(ev.clientX, ev.clientY)); return; }
  if (state.tool === 'note') { addNote(toWorld(ev.clientX, ev.clientY)); return; }
  state.sel = null; draw(); showInspector(); drawOutline();
  drag = { kind: 'cam', x: ev.clientX, y: ev.clientY, cx: state.cam.x, cy: state.cam.y };
  $('#stage').classList.add('panning');
});

window.addEventListener('mousemove', ev => {
  if (!drag) return;
  if (drag.kind === 'cam') {
    state.cam.x = drag.cx + (ev.clientX - drag.x);
    state.cam.y = drag.cy + (ev.clientY - drag.y);
    applyCam();
  } else {
    const p = state.pos.get(drag.id);
    p.x = drag.bx + (ev.clientX - drag.x) / state.cam.k;
    p.y = drag.by + (ev.clientY - drag.y) / state.cam.k;
    const b = [...state.boxes, ...state.plan.boxes].find(x => x.id === drag.id);
    if (b) b.pinned = true;
    if (Math.abs(ev.clientX - drag.x) + Math.abs(ev.clientY - drag.y) > 3) drag.moved = true;
    draw();
  }
});

window.addEventListener('mouseup', () => {
  $('#stage').classList.remove('panning');
  drag = null;
});

$('#stage').addEventListener('dblclick', ev => {
  const boxEl = ev.target.closest('.box');
  if (!boxEl) return;
  const id = boxEl.dataset.id;
  if (id.startsWith('group:') || id.startsWith('file:')) toggleOpen(id);
});

$('#stage').addEventListener('wheel', ev => {
  ev.preventDefault();
  const r = $('#stage').getBoundingClientRect();
  const mx = ev.clientX - r.left, my = ev.clientY - r.top;
  const before = { x: (mx - state.cam.x) / state.cam.k, y: (my - state.cam.y) / state.cam.k };
  const k = Math.min(3, Math.max(0.1, state.cam.k * Math.pow(0.999, ev.deltaY * (ev.ctrlKey ? 4 : 1.6))));
  state.cam.k = k;
  state.cam.x = mx - before.x * k;
  state.cam.y = my - before.y * k;
  applyCam();
}, { passive: false });

for (const b of document.querySelectorAll('.toolbar button')) {
  b.onclick = () => {
    const t = b.dataset.tool;
    if (t === 'tidy') { for (const x of [...state.boxes, ...state.plan.boxes]) x.pinned = false; state.pos.clear(); layout(); draw(); fitView(); return; }
    state.tool = t; state.linkFrom = null;
    for (const o of document.querySelectorAll('.toolbar button')) o.classList.toggle('on', o === b);
    $('#stage').classList.toggle('pan-ready', t === 'pan');
    $('#stage').classList.toggle('linking', t === 'arrow');
  };
}

$('#zoomIn').onclick = () => { state.cam.k = Math.min(3, state.cam.k * 1.2); applyCam(); };
$('#zoomOut').onclick = () => { state.cam.k = Math.max(0.1, state.cam.k / 1.2); applyCam(); };
$('#zoomFit').onclick = fitView;
$('#resetView').onclick = async () => { state.open.clear(); state.pos.clear(); await refresh(true); };
$('#collapseAll').onclick = async () => { state.open.clear(); await refresh(true); };
$('#sheetClose').onclick = closeSheet;
$('#scrim').onclick = closeSheet;
$('#workspaceNotes').onchange = () => { persistPlan(); $('#savedAt').textContent = 'saved'; };

// search
const search = $('#search');
search.addEventListener('input', async () => {
  const q = search.value.trim();
  const box = $('#searchResults');
  if (q.length < 2) { box.hidden = true; return; }
  const res = await api('/search?q=' + encodeURIComponent(q));
  box.hidden = false;
  box.innerHTML = res.hits.map(h =>
    `<div class="row" data-open="${esc(h.open.join('|'))}" data-sel="${esc(h.id)}">
      <span>${esc(h.label)}</span><span class="p">${esc(h.path)}</span></div>`).join('')
    || '<div class="row">nothing</div>';
  for (const row of box.querySelectorAll('[data-sel]')) {
    row.onclick = async () => {
      box.hidden = true; search.value = '';
      for (const id of row.dataset.open.split('|').filter(Boolean)) state.open.add(id);
      await refresh();
      state.sel = row.dataset.sel; draw(); showInspector(); drawOutline();
      centreOn(state.sel);
    };
  }
});
window.addEventListener('keydown', ev => {
  if ((ev.metaKey || ev.ctrlKey) && ev.key === 'k') { ev.preventDefault(); search.focus(); }
  if (ev.key === 'Escape') { closeSheet(); $('#searchResults').hidden = true; state.linkFrom = null; }
});

function centreOn(id) {
  const p = state.pos.get(id); if (!p) return;
  const r = $('#stage').getBoundingClientRect();
  state.cam.x = r.width / 2 - p.x * state.cam.k;
  state.cam.y = r.height / 2 - p.y * state.cam.k;
  applyCam();
}

// ---------------------------------------------------------------- the plan layer

let planSeq = 1;
function addPlannedBox(at) {
  const title = prompt('What is it called?');
  if (!title) return;
  const id = 'plan:' + Date.now().toString(36) + (planSeq++);
  const b = { id, level: 'planned', title, whatItDoes: '', decisions: [], where: '', pinned: true };
  state.plan.boxes.push(b);
  state.pos.set(id, { x: at.x - SIZE.planned.w / 2, y: at.y - SIZE.planned.h / 2 });
  state.sel = id;
  persistPlan(); draw(); showInspector();
}

function addPlannedEdge(from, to) {
  const note = prompt('What should travel along this arrow?\n\nSay what it carries and what the other end must hand back.');
  if (note === null) return;
  state.plan.edges.push({ from, to, note: note || '', planned: true });
  persistPlan(); draw(); showInspector();
  said('Arrow drawn.');
}

function addNote(at) {
  const text = prompt('Note');
  if (!text) return;
  state.plan.notes = state.plan.notes || [];
  state.plan.notes.push({ text, x: at.x, y: at.y });
  persistPlan(); drawNotes();
}

function drawNotes() {
  const layer = $('#noteLayer');
  layer.textContent = '';
  for (const n of state.plan.notes || []) {
    const g = el('g');
    g.setAttribute('class', 'sticky');
    g.setAttribute('transform', `translate(${n.x} ${n.y})`);
    const lines = wrap(n.text, 20).slice(0, 6);
    const r = el('rect');
    r.setAttribute('width', 150); r.setAttribute('height', 26 + lines.length * 16);
    g.appendChild(r);
    lines.forEach((l, i) => {
      const t = el('text');
      t.setAttribute('x', 12); t.setAttribute('y', 24 + i * 16);
      t.textContent = l;
      g.appendChild(t);
    });
    layer.appendChild(g);
  }
}

boot().catch(err => {
  document.body.innerHTML = `<div style="padding:40px;font-family:system-ui">
    <h2>Could not start</h2><pre>${esc(err.message)}</pre></div>`;
});
