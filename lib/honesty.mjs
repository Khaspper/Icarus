// The honesty loop.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readSymbols, canReadDeeply } from './reader.mjs';

/**
 * Read the code that was actually written and compare it against the box that
 * asked for it. Not by trusting what the agent said it did — by reading each
 * file before and after and seeing which things are genuinely new.
 *
 * When the two disagree, the code wins and the box says so. If the box won,
 * the map would start lying, and a map you cannot trust is worth nothing.
 */
export function readBack({ repoRoot, files, boxTitle }) {
  const appeared = [];
  for (const rel of files) {
    const abs = path.join(repoRoot, rel);
    if (!fs.existsSync(abs) || !canReadDeeply(rel)) continue;

    const after = readSymbols(rel, fs.readFileSync(abs, 'utf8'));
    let before = [];
    try {
      const old = execFileSync('git', ['show', `HEAD:${rel}`], { cwd: repoRoot, maxBuffer: 1 << 24 }).toString();
      before = readSymbols(rel, old);
    } catch { /* a brand new file: everything in it is new */ }

    const had = new Set(before.map(s => s.name));
    for (const sym of after) {
      if (!had.has(sym.name)) appeared.push({ ...sym, file: rel });
    }
  }

  const wanted = String(boxTitle).replace(/\(.*\)$/, '').trim().toLowerCase();
  const exact = appeared.find(s => s.name.toLowerCase() === wanted);
  const named = exact || appeared.find(s => s.name.toLowerCase().endsWith('.' + wanted));

  let mismatch = null;
  if (!files.length) {
    mismatch = 'Nothing was written to disk.';
  } else if (!appeared.length) {
    mismatch = `Files changed but nothing new was added to them. What changed: ${files.slice(0, 4).join(', ')}.`;
  } else if (!named) {
    mismatch = `This box asked for "${boxTitle}". What actually got written was ` +
      appeared.slice(0, 4).map(s => `${s.name} (${s.file}:${s.startLine})`).join(', ') +
      '. Rename the box, or change the code.';
  }

  return {
    landedAt: named ? `${named.file}:${named.startLine}-${named.endLine}` : null,
    mismatch,
    appeared: appeared.map(s => `${s.name} — ${s.file}:${s.startLine}-${s.endLine}`),
    changed: files,
  };
}

