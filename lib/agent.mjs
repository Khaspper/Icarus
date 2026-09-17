// Talking to the coding agent already installed on this machine.
//
// Two jobs, deliberately kept apart:
//   fill()  reads a corner of the repo and writes plain words about it.
//           It cannot write to disk. Cheap, safe, run often.
//   build() makes a real change from a planned box, in the real repo.
//           It can write, only inside that repo, and there is an undo.
//
// Three flags do the safety work and none of them are optional:
//   --permission-prompts none   nothing can ever stop and wait for a human,
//                               so the service cannot hang. Anything that
//                               would have asked is refused and written down.
//   --tools                     the agent only gets the tools named here.
//   --max-budget-usd            a hard stop if it runs away.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const CLI = process.env.CLAUDE_BIN || 'claude';

function env() {
  // The agent signs in through the machine's keychain, which needs USER and
  // HOME. Strip those and every call fails with a misleading "not logged in".
  return {
    ...process.env,
    DISABLE_AUTOUPDATER: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    CLAUDE_CODE_ENTRYPOINT: 'graph-ide',
  };
}

function run(args, { cwd, timeout = 900000, onEvent } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(CLI, args, { cwd, env: env(), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '', buffer = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('the agent took too long and was stopped'));
    }, timeout);

    child.stdout.on('data', d => {
      out += d;
      if (!onEvent) return;
      buffer += d;
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try { onEvent(JSON.parse(line)); } catch {}
      }
    });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => {
      clearTimeout(timer);
      reject(new Error(e.code === 'ENOENT' ? 'the Claude command is not on this machine' : e.message));
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0 && !out.trim()) {
        return reject(new Error(err.trim() || `the agent exited with ${code}`));
      }
      resolve(out);
    });
  });
}

// Never trust the exit code alone. The last word is in the result record.
function readResult(raw) {
  let record = null;
  for (const line of raw.trim().split('\n')) {
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj.type === 'result' || obj.total_cost_usd !== undefined) record = obj;
  }
  if (!record) throw new Error('the agent did not answer');

  if (record.is_error) {
    const why = record.terminal_reason === 'api_error' && /not logged in/i.test(String(record.result || ''))
      ? 'the Claude command is not signed in on this machine — run claude once in a terminal'
      : record.subtype === 'error_max_budget_usd'
        ? 'the agent hit its spending limit before finishing'
        : String(record.result || record.terminal_reason || 'the agent failed');
    throw new Error(why);
  }

  return {
    text: record.result || '',
    structured: record.structured_output || null,
    cost: record.total_cost_usd,
    ms: record.duration_ms || record.duration_api_ms,
    sessionId: record.session_id,
    denials: record.permission_denials || [],
  };
}

// ---------------------------------------------------------------- filling in

const WORD_RULES = `Write for someone who has not read this code.
Short sentences. No jargon. Never write these words: idempotency, normalize,
decompose, payload, provenance, entity, orchestrate, hydrate, persist,
cardinality, schema. Write repeat delivery, tidy up, break apart, the data
sent, where it came from, thing, run in order, load, save, how many, shape
instead. Name only functions, files and tables you actually saw. If you are
not sure a thing exists, leave it out.`;

const FILL_SCHEMA = {
  type: 'object',
  properties: {
    whatItDoes: { type: 'string', description: 'one to three plain sentences' },
    dataIn: { type: 'array', items: { type: 'string' }, description: 'what goes in, up to 8, each under 12 words' },
    manipulation: { type: 'array', items: { type: 'string' }, description: 'what it decides or changes, up to 8' },
    dataOut: { type: 'array', items: { type: 'string' }, description: 'what comes out, up to 8' },
    tablesTouched: { type: 'array', items: { type: 'string' }, description: 'exact table names, or empty' },
    functionsCalled: { type: 'array', items: { type: 'string' }, description: 'exact function names seen, or empty' },
    observed: { type: 'string', description: 'one sentence on what a person would notice, or empty' },
  },
  required: ['whatItDoes', 'dataIn', 'manipulation', 'dataOut', 'tablesTouched', 'functionsCalled'],
};

export async function fill({ repoRoot, box, files, symbols, model = 'sonnet' }) {
  const what = box.level === 'group'
    ? `the part of this repo under ${box.folder}/`
    : box.level === 'file' ? `the file ${box.path}`
    : `the function ${box.title} in ${box.path}, which starts at line ${box.startLine}`;

  const listing = files.slice(0, 40).map(f => '  ' + f).join('\n');
  const known = symbols.slice(0, 60).map(s => '  ' + s).join('\n');

  const prompt = `Read ${what} and write down what it is for.
${files.length ? `\nFiles in it:\n${listing}${files.length > 40 ? `\n  …and ${files.length - 40} more` : ''}\n` : ''}${known ? `\nThings already known to be in it:\n${known}\n` : ''}
${WORD_RULES}

Read the code before answering.`;

  const raw = await run([
    '-p', prompt,
    '--output-format', 'json',
    '--json-schema', JSON.stringify(FILL_SCHEMA),
    '--model', model,
    '--tools', 'Read', 'Grep', 'Glob',
    '--permission-mode', 'dontAsk',
    '--permission-prompts', 'none',
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--no-session-persistence',
    '--max-budget-usd', '0.75',
  ], { cwd: repoRoot, timeout: 300000 });

  const res = readResult(raw);
  const meaning = res.structured || safeParse(res.text);
  if (!meaning) throw new Error('nothing usable came back');
  return { meaning, cost: res.cost, ms: res.ms };
}

function safeParse(text) {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = fenced ? fenced[1] : text;
  const a = body.indexOf('{'), b = body.lastIndexOf('}');
  if (a < 0 || b < a) return null;
  try { return JSON.parse(body.slice(a, b + 1)); } catch { return null; }
}

// ---------------------------------------------------------------- building

/**
 * The brief is the whole point of the idea. It is the box, its decisions, and
 * the note on every arrow touching it. The person's words come first, because
 * they outrank the agent's own reading of the code around it.
 */
export function composeBrief({ box, plan, boxes, meaning, lookup }) {
  const nameOf = id => {
    const b = boxes.find(x => x.id === id);
    if (b) return b.path ? `${b.title} (${b.path})` : b.title;
    // The box may be closed right now, so fall back to the map itself rather
    // than showing the agent an internal name nobody wrote.
    const real = lookup && lookup(id);
    if (real) return `${real.label} (${real.file}:${real.line})`;
    return id.replace(/^(group|file|sym|plan):/, '');
  };

  const incoming = plan.edges.filter(e => e.to === box.id);
  const outgoing = plan.edges.filter(e => e.from === box.id);

  const lines = [];
  lines.push(`Build this: ${box.title}`);
  lines.push('');
  lines.push('What it should do');
  lines.push('  ' + (box.whatItDoes || '(not said)'));

  if (box.decisions && box.decisions.length) {
    lines.push('', 'Decisions it makes');
    for (const d of box.decisions) lines.push('  - ' + d);
  }
  if (box.where) {
    lines.push('', 'Where the code should go');
    lines.push('  ' + box.where);
  }
  if (incoming.length) {
    lines.push('', 'What reaches it, and what it must expect');
    for (const e of incoming) lines.push(`  - from ${nameOf(e.from)}: ${e.note || '(nothing said)'}`);
  }
  if (outgoing.length) {
    lines.push('', 'What it must hand on');
    for (const e of outgoing) lines.push(`  - to ${nameOf(e.to)}: ${e.note || '(nothing said)'}`);
  }

  const touched = [...new Set([...incoming.map(e => e.from), ...outgoing.map(e => e.to)])];
  const written = touched.filter(id => meaning[id]);
  if (written.length) {
    lines.push('', 'What the boxes it touches are for');
    for (const id of written) lines.push(`  - ${nameOf(id)}: ${meaning[id].whatItDoes}`);
  }

  lines.push('');
  lines.push('These words outrank whatever the surrounding code seems to suggest.');
  lines.push('If they contradict the code, follow these words and say so.');
  return lines.join('\n');
}

export async function build({ repoRoot, brief, model = 'sonnet', onEvent, budget = '1.50' }) {
  const prompt = `${brief}

Make this change in this repo now. Keep it small and keep it to the point.
Do not reformat code you did not need to touch. Do not add comments explaining
that you added something. Do not commit. When you are done, reply with one
short paragraph saying what you changed and where, and nothing else.`;

  const raw = await run([
    '-p', prompt,
    '--output-format', 'stream-json', '--verbose',
    '--model', model,
    '--tools', 'Read', 'Edit', 'Write', 'Glob', 'Grep',
    '--permission-mode', 'acceptEdits',
    '--permission-prompts', 'none',
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--session-id', randomUUID(),
    '--max-budget-usd', budget,
  ], { cwd: repoRoot, timeout: 900000, onEvent });

  const res = readResult(raw);
  return {
    summary: String(res.text).trim(),
    cost: res.cost,
    ms: res.ms,
    denials: res.denials,
  };
}

/** Run once at boot so a broken sign-in fails here, not mid-demo. */
export async function preflight() {
  const raw = await run([
    '-p', 'ok', '--output-format', 'json', '--model', 'haiku',
    '--permission-mode', 'dontAsk', '--permission-prompts', 'none',
    '--no-session-persistence', '--max-budget-usd', '0.30',
  ], { timeout: 60000 });
  return readResult(raw);
}

// ---------------------------------------------------------------- the map's reading

/**
 * A read-only question about the repo, same safety flags as fill(). The node
 * map uses it twice: once to name the big parts, once to read a node out.
 * It cannot write, cannot stop and wait, and gives up when it has spent enough.
 */
export async function ask({
  repoRoot, prompt, schema, model = 'sonnet',
  budget = '0.75', timeout = 300000, tools = ['Read', 'Grep', 'Glob'],
}) {
  const args = [
    '-p', prompt,
    '--output-format', 'json',
    '--model', model,
    '--permission-mode', 'dontAsk',
    '--permission-prompts', 'none',
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--no-session-persistence',
    '--max-budget-usd', String(budget),
  ];
  if (schema) args.push('--json-schema', JSON.stringify(schema));
  if (tools && tools.length) args.push('--tools', ...tools);

  const raw = await run(args, { cwd: repoRoot, timeout });
  const res = readResult(raw);
  const out = res.structured || safeParse(res.text);
  if (!out) throw new Error('nothing usable came back');
  return { out, cost: res.cost, ms: res.ms };
}

/** The plain-words rules, so every caller writes to the same standard. */
export const WORD_RULES_TEXT = WORD_RULES;
