// Free re-reader. No model, no dependencies.
//
// The shape layer we already have records where a thing STARTS. The honesty
// loop needs to know where it ENDS too, so a built box can remember exactly
// which lines its code landed on. That is all this file adds.
//
// Handles TypeScript and JavaScript properly. Everything else gets a shallow
// read that finds top-level names but does not pretend to know their extent.

const TS_EXT = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);

export function canReadDeeply(path) {
  return TS_EXT.has(extOf(path));
}

function extOf(path) {
  const i = path.lastIndexOf('.');
  return i < 0 ? '' : path.slice(i).toLowerCase();
}

// Walk the text once, recording for every character whether it is real code or
// inside a string, comment or template. Brace matching then only trusts code.
function classify(text) {
  const mask = new Uint8Array(text.length); // 1 = real code
  let i = 0;
  const n = text.length;
  // Stack of template-literal depths so `${ a ? `x` : `y` }` survives.
  const templates = [];
  let prevCode = ''; // last meaningful code char, for regex-vs-divide

  while (i < n) {
    const c = text[i];
    const c2 = text[i + 1];

    if (c === '/' && c2 === '/') {
      while (i < n && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && c2 === '*') {
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'") {
      i++;
      while (i < n) {
        if (text[i] === '\\') { i += 2; continue; }
        if (text[i] === c || text[i] === '\n') { i++; break; }
        i++;
      }
      prevCode = c;
      continue;
    }
    if (c === '`') {
      i++;
      let depth = 0;
      while (i < n) {
        if (text[i] === '\\') { i += 2; continue; }
        if (text[i] === '$' && text[i + 1] === '{') {
          // Inside ${ } we are back in real code; recurse by letting the outer
          // loop handle it, tracked with a depth counter.
          depth++;
          i += 2;
          let inner = 1;
          const start = i;
          // Mark the interpolation body as code and let brace counting use it.
          while (i < n && inner > 0) {
            if (text[i] === '{') inner++;
            else if (text[i] === '}') inner--;
            else if (text[i] === '`') {
              // Nested template. Skip it wholesale; good enough for our purpose.
              i++;
              while (i < n && text[i] !== '`') { if (text[i] === '\\') i++; i++; }
            }
            if (inner > 0) { mask[i] = 1; i++; }
          }
          i++; // past the closing }
          void start;
          continue;
        }
        if (text[i] === '`') { i++; break; }
        i++;
      }
      prevCode = '`';
      continue;
    }
    if (c === '/' && isRegexStart(prevCode)) {
      i++;
      let inClass = false;
      while (i < n) {
        if (text[i] === '\\') { i += 2; continue; }
        if (text[i] === '[') inClass = true;
        else if (text[i] === ']') inClass = false;
        else if (text[i] === '/' && !inClass) { i++; break; }
        else if (text[i] === '\n') break;
        i++;
      }
      prevCode = '/';
      continue;
    }

    mask[i] = 1;
    if (!/\s/.test(c)) prevCode = c;
    i++;
  }
  return mask;
}

// A slash starts a regex when the thing before it cannot end an expression.
function isRegexStart(prev) {
  if (prev === '') return true;
  return !/[)\]}\w$'"`]/.test(prev);
}

function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return starts;
}

function lineOf(starts, offset) {
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid; else hi = mid - 1;
  }
  return lo + 1;
}

// From the offset of a declaration, find the offset just past its closing brace.
function endOfBlock(text, mask, from) {
  const n = text.length;
  let i = from;
  // Find the opening brace that belongs to this declaration, without running
  // past the end of the statement.
  while (i < n) {
    if (mask[i]) {
      const c = text[i];
      if (c === '{') break;
      // A one-line arrow or a bare declaration ends at the semicolon.
      if (c === ';') return i + 1;
    }
    i++;
  }
  if (i >= n) return null;
  let depth = 0;
  for (; i < n; i++) {
    if (!mask[i]) continue;
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return null;
}

const DECLS = [
  // kind, pattern. The name is always capture group 1.
  ['function', /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/],
  ['class', /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/],
  ['interface', /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/],
  ['type', /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)/],
  ['enum', /^\s*(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/],
  ['function', /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*(?::[^=]*)?=>|[A-Za-z_$][\w$]*\s*=>)/],
  ['const', /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[:=]/],
];

// Methods inside a class body: `name(args) {`, `async name(args) {`, `get name() {`.
const METHOD = /^\s*(?:public\s+|private\s+|protected\s+|readonly\s+|static\s+|abstract\s+|override\s+)*(?:async\s+)?(?:get\s+|set\s+)?(\*\s*)?([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\([^;]*$/;

const NOT_A_METHOD = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'await',
  'function', 'constructor', 'new', 'delete', 'throw', 'do', 'else', 'super',
]);

/**
 * Read one file's symbols, each with the line it starts on and the line it
 * ends on. Returns [] for a file we cannot read deeply.
 */
export function readSymbols(path, text) {
  if (!canReadDeeply(path)) return readShallow(path, text);

  const mask = classify(text);
  const starts = lineStarts(text);
  const out = [];

  for (let li = 0; li < starts.length; li++) {
    const from = starts[li];
    const to = li + 1 < starts.length ? starts[li + 1] : text.length;
    const line = text.slice(from, to);
    if (!mask[from] && !/\S/.test(line.slice(0, 1))) {
      // Leading whitespace is unmasked by design; keep going.
    }
    // Skip lines that begin inside a string or comment.
    const firstCode = firstCodeOffset(mask, from, to);
    if (firstCode == null) continue;

    // Only top-level declarations. A local variable inside a function is not
    // a box on the map, and the shape layer we already have does not record
    // one either.
    if (/^\s/.test(line)) continue;

    for (const [kind, re] of DECLS) {
      const m = line.match(re);
      if (!m) continue;
      const end = endOfBlock(text, mask, from);
      out.push({
        name: m[1],
        kind,
        startLine: li + 1,
        endLine: end == null ? li + 1 : lineOf(starts, end - 1),
      });
      break;
    }
  }

  // Methods: only look inside the line span of a class we already found.
  for (const cls of out.filter(s => s.kind === 'class')) {
    for (let li = cls.startLine; li < cls.endLine - 1; li++) {
      const from = starts[li];
      const to = li + 1 < starts.length ? starts[li + 1] : text.length;
      const line = text.slice(from, to);
      const m = line.match(METHOD);
      if (!m) continue;
      const name = m[2];
      if (NOT_A_METHOD.has(name)) continue;
      if (out.some(s => s.startLine === li + 1)) continue;
      const end = endOfBlock(text, mask, from);
      if (end == null) continue;
      out.push({
        name: `${cls.name}.${name}`,
        kind: 'method',
        startLine: li + 1,
        endLine: lineOf(starts, end - 1),
      });
    }
  }

  out.sort((a, b) => a.startLine - b.startLine);
  return out;
}

function firstCodeOffset(mask, from, to) {
  for (let i = from; i < to; i++) if (mask[i]) return i;
  return null;
}

// Anything we cannot parse: find names, admit we do not know their extent.
const SHALLOW = [
  /^\s*def\s+([A-Za-z_][\w]*)/,            // python
  /^\s*class\s+([A-Za-z_][\w]*)/,          // python, others
  /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)/, // go
  /^\s*(?:pub\s+)?fn\s+([A-Za-z_][\w]*)/,  // rust
  /^\s*create\s+(?:or\s+replace\s+)?(?:table|function|view)\s+(?:if\s+not\s+exists\s+)?["']?([\w.]+)/i, // sql
];

function readShallow(path, text) {
  const lines = text.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    for (const re of SHALLOW) {
      const m = lines[i].match(re);
      if (m) {
        out.push({ name: m[1], kind: 'symbol', startLine: i + 1, endLine: null, shallow: true });
        break;
      }
    }
  }
  return out;
}
