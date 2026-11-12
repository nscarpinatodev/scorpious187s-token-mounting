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

  // Pins the invariant behind seatFor in movement.js: a seat index means
  // nothing without the count it was generated for, so every rider on a mount
  // must be positioned from one grid sized from that mount. Sizing per rider
  // put seat 0 on a 2-seat grid and seat 3 on a 4-seat grid, and they overlapped.
  const onTwo = JSON.stringify(generateSeats(2)[0]);
  const onFour = JSON.stringify(generateSeats(4)[0]);
  check('seat 0 is grid-dependent', onTwo !== onFour, true);

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

// ── 6. Mount name detection ──────────────────────────────────────────────────
// Pure string matching, so the false-positive behaviour that would actually
// annoy a table can be pinned here rather than discovered mid-session.
console.log('\nMount name detection');
{
  const { looksLikeMount, DEFAULT_MOUNT_NAMES } = await import(
    'file://' + path.join(root, 'scripts/mount-detection.js').replace(/\\/g, '/')
  );

  const check = (label, actual, expected) => {
    if (actual === expected) pass(`${label} → ${actual}`);
    else fail(`${label} → got ${actual}, expected ${expected}`);
  };

  check('"Riding Horse"', looksLikeMount('Riding Horse'), true);
  check('"Warhorse"', looksLikeMount('Warhorse'), true);
  check('"Giant Elk"', looksLikeMount('Giant Elk'), true);
  check('"pegasus" lowercase', looksLikeMount('pegasus'), true);

  // Word boundaries: the whole reason the match is not a substring test.
  check('"Horseshoe Crab" is not a mount', looksLikeMount('Horseshoe Crab'), false);
  check('"Ponytail Fern" is not a mount', looksLikeMount('Ponytail Fern'), false);

  check('"Goblin" is not a mount', looksLikeMount('Goblin'), false);
  check('empty name', looksLikeMount(''), false);
  check('null name', looksLikeMount(null), false);

  // Ambiguous creatures are deliberately absent, so a table can add them
  // without every one in the scene becoming a drop target by default.
  check('"Wolf" is not a default mount', looksLikeMount('Wolf'), false);
  check('"Dire Wolf" is', looksLikeMount('Dire Wolf'), true);

  // A custom list replaces the defaults rather than extending them.
  check('custom list matches', looksLikeMount('Sand Skiff', ['skiff']), true);
  check('custom list excludes defaults', looksLikeMount('Horse', ['skiff']), false);

  // A regex metacharacter in a user-supplied term must not throw or over-match.
  check('regex metacharacters are literal', looksLikeMount('a.c', ['a.c']), true);
  check('metacharacters do not wildcard', looksLikeMount('abc', ['a.c']), false);

  check('defaults are non-empty', DEFAULT_MOUNT_NAMES.length > 0, true);
}

// ── 7. Movement action config ────────────────────────────────────────────────
// v14 normalises a shorthand action descriptor into its full form; v13 does not
// and reads the fields as written. Core calls `canSelect`, `getCostFunction` and
// `deriveTerrainDifficulty` without checking their type, so a shorthand value
// left here throws on v13 — and `canSelect` throws while the Token HUD and Token
// Config are building their movement palettes, taking right-click and the token
// settings sheet down with it. Pinned because it is invisible on the v14 box.
console.log('\nMovement action config');
{
  const actions = {};
  const priorConfig = globalThis.CONFIG;
  globalThis.CONFIG = { Token: { movement: { actions, defaultSpeed: 6 } } };

  const { registerCarryAction, CARRY_ACTION } = await import(
    'file://' + path.join(root, 'scripts/carry-action.js').split(path.sep).join('/')
  );

  const check = (label, actual, expected) => {
    if (actual === expected) pass(`${label} → ${actual}`);
    else fail(`${label} → got ${actual}, expected ${expected}`);
  };

  check('registers', registerCarryAction(), true);
  const config = actions[CARRY_ACTION];

  // The three fields v13 invokes without a typeof guard.
  for (const key of ['canSelect', 'getCostFunction', 'deriveTerrainDifficulty', 'getAnimationOptions']) {
    check(`${key} is a function`, typeof config?.[key], 'function');
  }

  // The shorthand spellings must be absent, or v13 silently drops the semantics
  // they were standing in for.
  for (const key of ['costMultiplier', 'terrainAction', 'speedMultiplier']) {
    check(`no shorthand "${key}"`, key in (config ?? {}), false);
  }

  // Values, not just shapes: carried movement is unselectable, free, and flat.
  // Called through a guard so a regression to the shorthand form is reported as
  // a failed check rather than crashing this tool with the very TypeError it is
  // here to catch.
  const call = (fn, ...args) => (typeof fn === 'function' ? fn(...args) : '<not a function>');

  check('canSelect() is false', call(config?.canSelect, {}), false);
  check('cost is zero', call(call(config?.getCostFunction, {}, {}), 1, {}), 0);
  check('terrain difficulty is 1', call(config?.deriveTerrainDifficulty, {}), 1);

  // v14 side of the contract: normalisation must be a provable no-op.
  // `Game##initializeMovementActions` only fills fields that are `undefined`
  // and only consumes the shorthand spellings, so a config with every field
  // explicitly present passes through it untouched. Asserting that here is what
  // makes one config correct on both generations rather than a v13-only fix.
  const v14Defaults = [
    'img', 'order', 'teleport', 'measure', 'walls', 'visualize',
    'getAnimationOptions', 'canSelect', 'deriveTerrainDifficulty', 'getCostFunction',
  ];
  const unset = v14Defaults.filter(k => config?.[k] === undefined);
  check('v14 would default nothing', unset.join(',') || 'none', 'none');

  // label and icon are the two v14 throws outright on.
  check('label is present', typeof config?.label, 'string');
  check('icon is present', typeof config?.icon, 'string');

  // v13 has no default for these; the HUD and ruler read them directly.
  check('img is explicit', config?.img, null);
  check('does not teleport', config?.teleport, false);
  check('is not measured', config?.measure, false);
  check('is not wall-blocked', config?.walls, null);
  check('is not visualized', config?.visualize, false);

  globalThis.CONFIG = priorConfig;
}

// ── 8. Mount pace ────────────────────────────────────────────────────────────
// Riders have to animate at their mount's pace or they visibly drift off it.
// The action configs here are in the shape v14's normaliser leaves them — pace
// only reachable through `getAnimationOptions` — plus a v13-style absolute
// `movementSpeed`, because reading a raw `speedMultiplier` is exactly what used
// to make every mount look like it was walking.
console.log('\nMount pace');
{
  const actions = {
    walk: { getAnimationOptions: () => ({ speedMultiplier: 1 }) },
    swim: { getAnimationOptions: () => ({ speedMultiplier: 0.5 }) },
    blink: { getAnimationOptions: () => ({ speedMultiplier: Infinity }) },
    displace: { getAnimationOptions: () => ({ duration: 0 }) },
    sprint: { getAnimationOptions: () => ({ movementSpeed: 12 }) },
  };
  const priorConfig = globalThis.CONFIG;
  globalThis.CONFIG = { Token: { movement: { actions, defaultSpeed: 6 } } };

  const { registerCarryAction, CARRY_ACTION, segmentSpeed, movementDuration } = await import(
    'file://' + path.join(root, 'scripts/carry-action.js').split(path.sep).join('/')
  );
  registerCarryAction();
  const pace = (token) => actions[CARRY_ACTION].getAnimationOptions(token);

  const check = (label, actual, expected) => {
    if (actual === expected) pass(`${label} → ${actual}`);
    else fail(`${label} → got ${actual}, expected ${expected}`);
  };
  const json = (value) => JSON.stringify(value);

  const scene = { dimensions: { size: 100, distancePixels: 20 }, tokens: new Map() };
  const token = (id, { mount, action = 'walk', passed = [] } = {}) => {
    const doc = {
      id, parent: scene, movementAction: action,
      movement: { passed: { waypoints: passed.map(a => ({ action: a })) } },
      getFlag: (scope, key) => (key === 'mount' && mount ? { tokenId: mount, seat: 0 } : undefined),
    };
    scene.tokens.set(id, doc);
    return doc;
  };

  // Per-segment speed, resolved the way core resolves it.
  check('walk', segmentSpeed({}, 'walk'), 6);
  check('swim is half pace', segmentSpeed({}, 'swim'), 3);
  check('absolute movementSpeed wins over base', segmentSpeed({}, 'sprint'), 12);
  check('blink (Infinity multiplier) is instant', segmentSpeed({}, 'blink'), Infinity);
  check('displace (duration 0) is instant', segmentSpeed({}, 'displace'), Infinity);
  check('unknown action falls back to base', segmentSpeed({}, 'nonexistent'), 6);
  check('difficult terrain divides speed', segmentSpeed({}, 'walk', { difficulty: 2 }), 3);
  check('terrain difficulty is capped at 10', segmentSpeed({}, 'walk', { difficulty: 50 }), 0.6);

  // The rider's default pace.
  token('horse');
  check('rider on a walking horse', json(pace(token('r1', { mount: 'horse' }))), '{"movementSpeed":6}');
  token('seal', { action: 'swim' });
  check('rider on a swimming mount', json(pace(token('r2', { mount: 'seal' }))), '{"movementSpeed":3}');
  token('imp', { action: 'blink' });
  check('rider on a blinking mount is instant', json(pace(token('r3', { mount: 'imp' }))), '{"duration":0}');

  // What was actually travelled beats the stored default, which a ruler overrides.
  token('dragged', { action: 'walk', passed: ['swim', 'swim'] });
  check('ruler-selected action beats default', json(pace(token('r4', { mount: 'dragged' }))), '{"movementSpeed":3}');
  token('mixed', { passed: ['walk', 'blink'] });
  check('a blink partway does not freeze a walk', json(pace(token('r5', { mount: 'mixed' }))), '{"movementSpeed":6}');
  token('allInstant', { passed: ['blink', 'displace'] });
  check('all-instant route is instant', json(pace(token('r6', { mount: 'allInstant' }))), '{"duration":0}');

  // A passenger on a carried knight moves at the dragon's pace.
  token('dragon', { action: 'swim' });
  token('knight', { mount: 'dragon', passed: [CARRY_ACTION] });
  check('chain resolves to the root mount', json(pace(token('page', { mount: 'knight' }))), '{"movementSpeed":3}');

  // Corrupted flags that make two tokens carry each other must not hang or throw.
  token('a', { mount: 'b', passed: [CARRY_ACTION] });
  token('b', { mount: 'a', passed: [CARRY_ACTION] });
  let cycle;
  try { cycle = json(pace(scene.tokens.get('a'))); } catch (err) { cycle = `threw: ${err.message}`; }
  check('mount cycle terminates', typeof cycle === 'string' && !cycle.startsWith('threw'), true);

  check('no mount → core default', json(pace(token('alone'))), '{}');

  // Only absolute values: a multiplier would be applied on top of the speed core
  // derives from the duration and put rider and mount back out of step.
  const returned = ['horse', 'seal', 'imp', 'dragged'].map((m, i) => pace(token(`k${i}`, { mount: m })));
  check('never returns speedMultiplier', returned.some(r => 'speedMultiplier' in r), false);

  // Whole-route duration, mirroring Token##getMovementAnimationDuration.
  const mover = { parent: scene, movementAction: 'walk' };
  const origin = { x: 0, y: 0, elevation: 0, width: 1, height: 1 };
  const ms = (movement) => {
    const value = movementDuration(mover, movement);
    return value === undefined ? undefined : Math.round(value);
  };
  check('6 squares walking at 6/s', ms({ origin, passed: { waypoints: [{ x: 600, y: 0, action: 'walk' }] } }), 1000);
  check('route mixing walk, swim, blink and terrain', ms({ origin, passed: { waypoints: [
    { x: 600, y: 0, action: 'walk' },
    { x: 900, y: 0, action: 'swim' },
    { x: 1900, y: 0, action: 'blink' },
    { x: 2500, y: 0, action: 'walk', terrain: { difficulty: 2 } },
  ] } }), 4000);
  check('elevation counts in grid distance', ms({ origin, passed: { waypoints: [{ x: 0, y: 0, elevation: 5, action: 'walk' }] } }), 167);
  check('resize uses half the size change', ms({ origin, passed: { waypoints: [{ x: 0, y: 0, width: 3, height: 1, action: 'walk' }] } }), 167);
  check('omitted action uses the default', ms({ origin, passed: { waypoints: [{ x: 300, y: 0 }] } }), 500);
  check('nothing travelled → unmeasured', ms({ origin, passed: { waypoints: [] } }), undefined);
  check('scene without grid → unmeasured',
    movementDuration({ parent: {} }, { origin, passed: { waypoints: [{ x: 600, y: 0 }] } }), undefined);

  globalThis.CONFIG = priorConfig;
}

// ── 9. Ownership revocation (v13 form) ───────────────────────────────────────
// Dismounting has to take back the OWNER it granted. A plain update merges into
// the stored ownership and keeps any key it omits, so the revoke payload is
// checked for shape here, and tools/verify-v14.mjs runs it through v14's real
// field code. With no `foundry.data.operators`, this exercises the `==`/`-=`
// keys v13 understands.
console.log('\nOwnership revocation (v13 form)');
{
  const M = 'scorpious187s-token-mounting';
  const OWNER = 3;
  const priorGlobals = { foundry: globalThis.foundry, CONST: globalThis.CONST, game: globalThis.game };
  globalThis.foundry = { utils: { deepClone: v => structuredClone(v) } };   // no data.operators → v13 path
  globalThis.CONST = { DOCUMENT_OWNERSHIP_LEVELS: { NONE: 0, LIMITED: 1, OBSERVER: 2, OWNER } };

  const { revokeMountOwnership, revokeAllGrants } = await import(
    'file://' + path.join(root, 'scripts/ownership.js').split(path.sep).join('/')
  );

  const check = (label, actual, expected) => {
    if (actual === expected) pass(`${label} → ${actual}`);
    else fail(`${label} → got ${actual}, expected ${expected}`);
  };

  // A minimal world: users, a mount actor that records the update it is sent,
  // and rider tokens whose actors are owned by given users.
  const users = ['alice', 'bob'].map(id => ({ id, isGM: false, active: true }));
  globalThis.game = { user: { isGM: true }, users: { filter: fn => users.filter(fn) } };

  const scenario = ({ ownership, grants, riders }) => {
    const sent = [];
    const actor = {
      name: 'Horse', ownership,
      getFlag: (scope, key) => (scope === M && key === 'grants' ? grants : undefined),
      update: async change => { sent.push(change); },
    };
    const scene = { tokens: [] };
    const mount = { id: 'mount', parent: scene, actor };
    const tokens = riders.map(([id, owner]) => ({
      id, parent: scene,
      actor: { testUserPermission: (u) => u.id === owner },
      getFlag: (scope, key) => (key === 'mount' ? { tokenId: 'mount', seat: 0 } : undefined),
    }));
    scene.tokens = tokens;
    return { mount, tokens, sent, scene };
  };

  // Alice had no entry before mounting, so dismounting must remove her key.
  {
    const s = scenario({ ownership: { default: 0, alice: OWNER }, grants: { alice: null }, riders: [['r1', 'alice']] });
    s.scene.tokens = [];                                 // r1 is the one leaving
    await revokeMountOwnership(s.mount, s.tokens[0]);
    const u = s.sent[0] ?? {};
    check('update is sent', s.sent.length, 1);
    check('ownership is replaced, not merged', '==ownership' in u && !('ownership' in u), true);
    check('ungranted user removed', JSON.stringify(u['==ownership']), '{"default":0}');
    check('grants flag cleared', u[`flags.${M}.-=grants`], null);
  }

  // An explicit earlier level comes back as it was.
  {
    const s = scenario({ ownership: { default: 0, alice: OWNER }, grants: { alice: 1 }, riders: [['r1', 'alice']] });
    s.scene.tokens = [];
    await revokeMountOwnership(s.mount, s.tokens[0]);
    check('explicit prior level restored', s.sent[0]?.['==ownership']?.alice, 1);
  }

  // A GM changed Alice to OBSERVER while she rode; that decision stands.
  {
    const s = scenario({ ownership: { default: 0, alice: 2 }, grants: { alice: null }, riders: [['r1', 'alice']] });
    s.scene.tokens = [];
    await revokeMountOwnership(s.mount, s.tokens[0]);
    check('level changed by GM is kept', s.sent[0]?.['==ownership']?.alice, 2);
    check('its grant record is still cleared', s.sent[0]?.[`flags.${M}.-=grants`], null);
  }

  // Alice leaves while Bob still rides: only Alice's grant goes.
  {
    const s = scenario({
      ownership: { default: 0, alice: OWNER, bob: OWNER },
      grants: { alice: null, bob: null },
      riders: [['r1', 'alice'], ['r2', 'bob']],
    });
    const leaving = s.tokens[0];
    s.scene.tokens = [s.tokens[1]];
    await revokeMountOwnership(s.mount, leaving);
    const u = s.sent[0] ?? {};
    check('leaver removed', 'alice' in (u['==ownership'] ?? { alice: 1 }), false);
    check('remaining rider keeps OWNER', u['==ownership']?.bob, OWNER);
    check("only the leaver's grant record is deleted", u[`flags.${M}.grants.-=alice`], null);
    check('the grants flag itself survives', `flags.${M}.-=grants` in u, false);
  }

  // Two riders owned by the same player: one leaving withdraws nothing.
  {
    const s = scenario({ ownership: { default: 0, alice: OWNER }, grants: { alice: null }, riders: [['r1', 'alice'], ['r2', 'alice']] });
    const leaving = s.tokens[0];
    s.scene.tokens = [s.tokens[1]];
    await revokeMountOwnership(s.mount, leaving);
    check('still-entitled user → no update', s.sent.length, 0);
  }

  // Deleting a mount clears every grant at once.
  {
    const s = scenario({ ownership: { default: 0, alice: OWNER, bob: 1 }, grants: { alice: null }, riders: [] });
    await revokeAllGrants(s.mount);
    const u = s.sent[0] ?? {};
    check('revokeAllGrants replaces ownership', JSON.stringify(u['==ownership']), '{"default":0,"bob":1}');
    check('revokeAllGrants clears the flag', u[`flags.${M}.-=grants`], null);
  }

  Object.assign(globalThis, priorGlobals);
}

// ── 10. Seat layouts ─────────────────────────────────────────────────────────
// Layouts are pure geometry in the mount's own frame, turned by its rotation,
// so the placements a table will actually see can be pinned exactly.
console.log('\nSeat layouts');
{
  const seating = await import('file://' + path.join(root, 'scripts/seating.js').split(path.sep).join('/'));
  const { generateSeats, seatPosition, pathRotations, SEAT_LAYOUTS } = seating;
  const { seatLayoutOf } = await import('file://' + path.join(root, 'scripts/token-options.js').split(path.sep).join('/'));

  const check = (label, actual, expected) => {
    if (actual === expected) pass(`${label} → ${actual}`);
    else fail(`${label} → got ${actual}, expected ${expected}`);
  };
  const pairs = seats => seats.map(s => `${s.dx},${s.dy}`).join(' ');

  // Grid is the original behaviour and must not move for existing worlds.
  check('grid is the default', pairs(generateSeats(4)), pairs(generateSeats(4, 'grid')));
  check('grid layout unchanged', pairs(generateSeats(4)), '-0.25,-0.25 0.25,-0.25 -0.25,0.25 0.25,0.25');
  check('unknown layout falls back to grid', pairs(generateSeats(3, 'nonsense')), pairs(generateSeats(3, 'grid')));

  check('centre stacks every rider', pairs(generateSeats(3, 'center')), '0,0 0,0 0,0');
  check('row runs side by side', pairs(generateSeats(3, 'row')), '-0.25,0 0,0 0.25,0');
  check('column puts seat 0 at the front', pairs(generateSeats(3, 'column')), '0,0.25 0,0 0,-0.25');
  check('one-seat column is centred', pairs(generateSeats(1, 'column')), '0,0');
  check('corners fill front pair, back pair, then centre', pairs(generateSeats(5, 'corners')),
    '-0.25,0.25 0.25,0.25 -0.25,-0.25 0.25,-0.25 0,0');
  check('corners give nine distinct seats', new Set(generateSeats(9, 'corners').map(s => `${s.dx},${s.dy}`)).size, 9);
  check('a tenth corner seat reuses the first', pairs([generateSeats(10, 'corners')[9]]), pairs([generateSeats(1, 'corners')[0]]));
  check('ring starts at the front', pairs(generateSeats(4, 'ring')), '0,0.3 -0.3,0 0,-0.3 0.3,0');

  let offMount = [];
  for (const layout of SEAT_LAYOUTS) {
    for (let n = 1; n <= 12; n++) {
      if (generateSeats(n, layout).some(s => Math.abs(s.dx) > 0.5 || Math.abs(s.dy) > 0.5)) offMount.push(`${layout}/${n}`);
    }
  }
  check('every layout stays on the mount (1–12 riders)', offMount.join(', ') || 'none', 'none');

  // Rotation. Front is +dy at rotation 0; Foundry's rotation is clockwise on screen.
  const grid = { grid: { size: 100 } };
  const rider = { width: 1, height: 1 };
  const front = { dx: 0, dy: 0.25 };
  const at = (rotation, extra = {}) => {
    const p = seatPosition({ x: 0, y: 0, width: 1, height: 1, rotation, parent: grid, ...extra }, rider, front);
    return `${p.x},${p.y}`;
  };
  check('front seat, facing down (0°)', at(0), '0,25');
  check('front seat turns left at 90°', at(90), '-25,0');
  check('front seat turns up at 180°', at(180), '0,-25');
  check('front seat turns right at -90°', at(-90), '25,0');
  check('Lock Rotation keeps seats fixed', at(90, { lockRotation: true }), '0,25');
  // A 2×1 wagon (200×100 px, centre 100,50): a seat a quarter along its length
  // is 50 px right of centre facing down, and 50 px below centre once turned.
  const wagonAt = rotation => {
    const p = seatPosition({ x: 0, y: 0, width: 2, height: 1, rotation, parent: grid }, rider, { dx: 0.25, dy: 0 });
    return `${p.x},${p.y}`;
  };
  check('a long mount, unturned', wagonAt(0), '100,0');
  check('a long mount turns its long axis', wagonAt(90), '50,50');

  // Facing along a route, as core auto-rotates: segment angle less 90°.
  const route = [{ x: 0, y: 100 }, { x: 100, y: 100 }, { x: 100, y: 100 }, { x: 100, y: 0 }];
  check('facing along a route', pathRotations({ x: 0, y: 0 }, route, 45).join(' '), '0 -90 -90 -180');
  check('a standstill keeps the starting facing', pathRotations({ x: 0, y: 0 }, [{ x: 0, y: 0 }], 45).join(' '), '45');
  check('undo faces backwards along the route', pathRotations({ x: 0, y: 0 }, [{ x: 0, y: 100 }], 0, 'undo').join(' '), '180');

  // Which layout a mount uses: its own choice, else the world's, else grid.
  const mount = flag => ({ getFlag: (scope, key) => (key === 'seatLayout' ? flag : undefined) });
  const priorGame = globalThis.game;
  globalThis.game = undefined;
  check('token choice wins', seatLayoutOf(mount('column')), 'column');
  check('Default with no world setting → grid', seatLayoutOf(mount('default')), 'grid');
  check('unrecognised choice → grid', seatLayoutOf(mount('sideways')), 'grid');
  globalThis.game = { settings: { get: () => 'ring' } };
  check('Default uses the world setting', seatLayoutOf(mount('default')), 'ring');
  check('token choice still beats the world', seatLayoutOf(mount('row')), 'row');
  globalThis.game = priorGame;
}

// ── Summary ──────────────────────────────────────────────────────────────────
console.log('');
if (failures) {
  console.error(`${failures} check(s) failed.\n`);
  process.exit(1);
}
console.log('All checks passed.\n');
