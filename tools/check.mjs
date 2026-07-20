/**
 * Pre-flight checks. Run with `node tools/check.mjs` before building.
 *
 * Foundry runs on a separate v13 server, so these cover the failure modes that
 * would otherwise only surface as a console error over there.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import os from 'node:os';

const root = path.resolve(import.meta.dirname, '..');
const LANG_PREFIX = 'S187TM';
let failures = 0;

const fail = msg => { console.error(`  FAIL  ${msg}`); failures++; };
const pass = msg => console.log(`  ok    ${msg}`);

function walk(dir, ext, out = []) {
  const abs = path.join(root, dir);
  if (!fs.existsSync(abs)) return out;
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(rel, ext, out);
    else if (ext.test(entry.name)) out.push(rel);
  }
  return out;
}

// ── 1. ESM syntax ────────────────────────────────────────────────────────────
// `node --check` parses .js as CommonJS, so stage copies as .mjs first.
console.log('\nESM syntax');
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-check-'));
  for (const file of walk('scripts', /\.js$/)) {
    const staged = path.join(tmp, file.replace(/[\\/]/g, '_') + '.mjs');
    fs.copyFileSync(path.join(root, file), staged);
    try {
      execFileSync(process.execPath, ['--check', staged], { stdio: 'pipe' });
    } catch (err) {
      fail(`${file}\n${String(err.stderr ?? err).split('\n').slice(0, 4).join('\n')}`);
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  if (!failures) pass('all scripts parse as ES modules');
}

// ── 2. JSON validity + byte-order marks ──────────────────────────────────────
// A BOM makes JSON.parse throw, so Foundry cannot read a manifest that has one
// and the module fails to load with no useful error. PowerShell 5.1 writes one
// by default from Set-Content -Encoding utf8, which is exactly how it happens.
console.log('\nJSON');
for (const file of ['module.json', 'lang/en.json']) {
  const buf = fs.readFileSync(path.join(root, file));
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    fail(`${file} — starts with a UTF-8 BOM; Foundry cannot parse it`);
    continue;
  }
  try {
    JSON.parse(buf.toString('utf8'));
    pass(file);
  } catch (err) {
    fail(`${file} — ${err.message}`);
  }
}

// ── 3. Localization keys ─────────────────────────────────────────────────────
console.log('\nLocalization keys');
{
  const defined = new Set(Object.keys(
    JSON.parse(fs.readFileSync(path.join(root, 'lang/en.json'), 'utf8')),
  ));
  const used = new Map();
  const pattern = new RegExp(`${LANG_PREFIX}\\.[A-Za-z0-9_.]+`, 'g');
  for (const file of [...walk('scripts', /\.js$/), ...walk('templates', /\.hbs$/)]) {
    const src = fs.readFileSync(path.join(root, file), 'utf8');
    for (const [key] of src.matchAll(pattern)) if (!used.has(key)) used.set(key, file);
  }
  const missing = [...used].filter(([k]) => !defined.has(k));
  const orphaned = [...defined].filter(k => !used.has(k));
  for (const [key, file] of missing) fail(`missing key ${key} (used in ${file})`);
  for (const key of orphaned) console.warn(`  warn  defined but unused: ${key}`);
  if (!missing.length) pass(`${used.size} keys referenced, all defined`);
}

// ── 4. Handlebars single-root ────────────────────────────────────────────────
// HandlebarsApplicationMixin throws "Template part must render a single HTML
// element" if a PART template has sibling roots.
console.log('\nHandlebars part structure');
{
  const files = walk('templates', /\.hbs$/);
  if (!files.length) pass('no templates to check');
  for (const file of files) {
    const src = fs.readFileSync(path.join(root, file), 'utf8')
      .replace(/\{\{![\s\S]*?\}\}/g, '')
      .replace(/\{\{[\s\S]*?\}\}/g, '');
    const voids = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img',
      'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
    let depth = 0, roots = 0;
    for (const m of src.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9-]*)([^>]*?)(\/?)>/g)) {
      const [, closing, tag, , selfClose] = m;
      const isVoid = voids.has(tag.toLowerCase()) || selfClose === '/';
      if (closing) depth--;
      else { if (depth === 0) roots++; if (!isVoid) depth++; }
    }
    if (roots === 1) pass(`${file} — single root`);
    else fail(`${file} — renders ${roots} root elements (must be exactly 1)`);
  }
}

// ── 5. Seat layout ───────────────────────────────────────────────────────────
// seating.js has no Foundry dependency, so its geometry can be tested rather
// than eyeballed on the server.
console.log('\nSeat layout');
{
  const { generateSeats, seatPosition } = await import(
    'file://' + path.join(root, 'scripts/seating.js').replace(/\\/g, '/')
  );

  const check = (label, actual, expected) => {
    if (actual === expected) pass(`${label} → ${actual}`);
    else fail(`${label} → got ${actual}, expected ${expected}`);
  };

  check('0 riders', generateSeats(0).length, 0);
  check('1 rider count', generateSeats(1).length, 1);
  check('1 rider is centred', JSON.stringify(generateSeats(1)[0]), '{"dx":0,"dy":0}');
  check('4 riders count', generateSeats(4).length, 4);
  check('7 riders count', generateSeats(7).length, 7);

  // Seats must stay within the mount's footprint or riders visibly hang off it.
  const inBounds = generateSeats(9).every(s => Math.abs(s.dx) <= 0.5 && Math.abs(s.dy) <= 0.5);
  check('9 riders stay within footprint', inBounds, true);

  // No two riders may share a seat.
  const seats = generateSeats(6).map(s => `${s.dx},${s.dy}`);
  check('6 riders are distinct', new Set(seats).size, 6);

  // A same-size rider centred on a same-size mount lands exactly on it.
  const mount = { x: 100, y: 200, width: 1, height: 1, elevation: 0, parent: { grid: { size: 100 } } };
  const rider = { width: 1, height: 1 };
  const pos = seatPosition(mount, rider, { dx: 0, dy: 0 });
  check('centred seat x', pos.x, 100);
  check('centred seat y', pos.y, 200);

  // A small rider centres on a large mount rather than sitting at its corner.
  const bigMount = { x: 0, y: 0, width: 4, height: 4, elevation: 30, parent: { grid: { size: 100 } } };
  const smallPos = seatPosition(bigMount, rider, { dx: 0, dy: 0 });
  check('small rider centred on 4x4 mount x', smallPos.x, 150);
  check('small rider centred on 4x4 mount y', smallPos.y, 150);
  check('rider inherits mount elevation', smallPos.elevation, 30);
}

// ── Summary ──────────────────────────────────────────────────────────────────
console.log('');
if (failures) {
  console.error(`${failures} check(s) failed.\n`);
  process.exit(1);
}
console.log('All checks passed.\n');
