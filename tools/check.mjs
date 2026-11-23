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

// ── Steering on the grid ─────────────────────────────────────────────────────
// A pilot sits somewhere on its mount, often between spaces. Its snapped drag
// must move the mount by whole spaces, not by the seat's offset.
console.log('\nSteering');
{
  const { steeredRoute } = await import(
    'file://' + path.join(root, 'scripts/seating.js').replace(/\\/g, '/')
  );
  const check = (label, actual, expected) => {
    if (actual === expected) pass(`${label} → ${actual}`);
    else fail(`${label} → got ${actual}, expected ${expected}`);
  };
  const size = 100;
  const grid = {
    size,
    isGridless: false,
    getOffset: ({ x, y }) => ({ i: Math.floor(y / size), j: Math.floor(x / size) }),
    getCenterPoint: ({ i, j }) => ({ x: (j + 0.5) * size, y: (i + 0.5) * size }),
  };
  const snapTo = ({ x, y }) => ({ x: Math.round(x / size) * size, y: Math.round(y / size) * size });
  const horse = (x, y) => ({ x, y, elevation: 0, width: 2, height: 2, getSnappedPosition: snapTo });
  const knight = (x, y) => ({ x, y, elevation: 0, width: 1, height: 1 });
  const where = route => route.map(point => `${point.x},${point.y}${point.snapped ? '' : '~'}`).join(' ');

  // The only rider on a horse two spaces wide sits on its middle: a grid corner.
  // Core snaps a half to the space below and to the right, which is also the
  // space the pilot's centre counts as being in, so straight down stays straight.
  const solo = steeredRoute(horse(1200, 300), knight(1250, 350), [{ x: 1300, y: 1000, snapped: true }], grid);
  check('centre seat, six spaces down: on the grid', where(solo), '1200,900');

  // Two riders in a row sit half a space down from the horse's top edge.
  const pair = steeredRoute(horse(400, 400), knight(400, 450), [{ x: 700, y: 500, snapped: true }], grid);
  check('row seat, three spaces across: no drift down', where(pair), '700,400');

  // Every turn of a route is counted from the same starting space.
  const bend = steeredRoute(horse(400, 400), knight(450, 450),
    [{ x: 500, y: 300, snapped: true }, { x: 500, y: 100, snapped: true }, { x: 800, y: 100, snapped: true }], grid);
  check('a route with turns keeps its shape', where(bend), '400,200 400,0 700,0');

  // A mount already left off the grid by an older version is put back on it.
  const adrift = steeredRoute(horse(1200, 950), knight(1200, 1000), [{ x: 1200, y: 700, snapped: true }], grid);
  check('an off-grid mount lands on the grid', where(adrift), '1200,700');

  // Shift-dragged, or no grid: the exact offset, as before.
  const free = steeredRoute(horse(400, 400), knight(450, 450), [{ x: 733, y: 512, snapped: false }], grid);
  check('a freely placed point keeps the offset', where(free), '683,462~');
  const gridless = steeredRoute(horse(400, 400), knight(450, 450), [{ x: 700, y: 500, snapped: true }], { ...grid, isGridless: true });
  check('gridless keeps the offset', where(gridless), '650,450~');
  const none = steeredRoute(horse(400, 400), knight(450, 450), [{ x: 700, y: 500, snapped: true }], null);
  check('no grid to ask keeps the offset', where(none), '650,450~');

  // The route a pilot's drag asks for is read where core puts it.
  const priorHooksForRoute = globalThis.Hooks;
  globalThis.Hooks = { on: () => {}, callAll: () => {} };
  const { requestedRoute, intendedPoints } = await import(
    'file://' + path.join(root, 'scripts/movement.js').replace(/\\/g, '/')
  );
  globalThis.Hooks = priorHooksForRoute;
  const step = (x, y, intermediate = false) => ({ x, y, intermediate, snapped: true });
  const asked = movement => where(requestedRoute(movement));
  // v14, an ordinary drag: everything is about to be travelled, nothing is pending.
  check('a whole route waiting in `passed`', asked({
    passed: { waypoints: [step(600, 600, true), step(600, 500), step(500, 500, true), step(300, 500)] },
    pending: { waypoints: [] },
    destination: { x: 300, y: 500 },
  }), '600,500 300,500');
  check('a checkpoint part-way: both halves, in order', asked({
    passed: { waypoints: [step(100, 0, true), step(200, 0)] },
    pending: { waypoints: [step(200, 100, true), step(200, 200)] },
  }), '200,0 200,200');
  check('no waypoints at all: the destination', asked({ destination: { x: 50, y: 60 } }), '50,60~');
  check('nowhere to go', requestedRoute({}).length, 0);

  // What the pilot meant, without a pathfinder's turns on the way there.
  const turn = (x, y) => ({ x, y, snapped: true });
  const set = (x, y) => ({ x, y, snapped: true, explicit: true, checkpoint: true });
  const end = (x, y) => ({ x, y, snapped: true, checkpoint: true });
  check('turns are left out, set waypoints and the end kept',
    where(intendedPoints([turn(100, 0), set(200, 0), turn(200, 100), turn(300, 200), end(400, 200)])), '200,0 400,200');
  check('a route marked nowhere is kept whole', where(intendedPoints([turn(100, 0), turn(200, 100)])), '100,0 200,100');
  check('no route', intendedPoints(undefined).length, 0);

  // Facings are compared as a token document stores them.
  const { facingOf } = await import(
    'file://' + path.join(root, 'scripts/seating.js').replace(/\\/g, '/')
  );
  check('a quarter turn left is 270', facingOf(-90), 270);
  check('a full turn is no turn', facingOf(360), 0);
  check('more than a full turn', facingOf(450), 90);
  check('trigonometry noise is not a turn', facingOf(89.99999999999999), 90);
  check('nothing to face', facingOf(undefined), undefined);
  check('not a number', facingOf('north'), undefined);

  // A flying mount carries its pilot's change of height.
  const climb = steeredRoute({ ...horse(400, 400), elevation: 20 }, { ...knight(450, 450), elevation: 20 },
    [{ x: 700, y: 500, elevation: 50, snapped: true }], grid);
  check('elevation follows the pilot', climb[0].elevation, 50);
}

// ── Riding together ──────────────────────────────────────────────────────────
// On dnd5e a mount and its riders must not count as obstacles to one another.
console.log('\nRiding together');
{
  const { ridesTogether, getSeat } = await import(
    'file://' + path.join(root, 'scripts/relations.js').replace(/\\/g, '/')
  );
  const priorHooks = globalThis.Hooks;
  const priorGame = globalThis.game;
  globalThis.Hooks = { on: () => {}, callAll: () => {} };
  const { ignoreOwnMount } = await import(
    'file://' + path.join(root, 'scripts/systems/dnd5e.js').replace(/\\/g, '/')
  );
  const check = (label, actual, expected) => {
    if (actual === expected) pass(`${label} → ${actual}`);
    else fail(`${label} → got ${actual}, expected ${expected}`);
  };

  const tokens = new Map();
  const scene = { id: 'scene', tokens };
  const make = (id, mount, seat = 0, parent = scene) => {
    const doc = { id, parent, getFlag: (scope, key) => (key === 'mount' && mount ? { tokenId: mount, seat } : undefined) };
    if (parent === scene) tokens.set(id, doc);
    return doc;
  };
  const dragon = make('dragon');
  const knight = make('knight', 'dragon', 0);
  const squire = make('squire', 'dragon', 1);
  const page = make('page', 'knight', 0);
  const goblin = make('goblin');
  const wolf = make('wolf');
  const elsewhere = make('dragon', null, 0, { id: 'other-scene', tokens: new Map() });

  check('rider and mount', ridesTogether(knight, dragon), true);
  check('mount and rider', ridesTogether(dragon, squire), true);
  check('two riders of one mount', ridesTogether(knight, squire), true);
  check('a rider of a rider, and the root', ridesTogether(page, dragon), true);
  check('a rider and a bystander', ridesTogether(knight, goblin), false);
  check('two bystanders', ridesTogether(goblin, wolf), false);
  check('a token and itself', ridesTogether(dragon, dragon), false);
  check('the same id on another scene', ridesTogether(knight, elsewhere), false);
  check('nothing to compare', ridesTogether(knight, null), false);

  check('seat of the pilot', getSeat(knight), 0);
  check('seat of a passenger', getSeat(squire), 1);
  check('seat of a token on foot', getSeat(goblin), null);

  // Whose mount a drag moves: down the reins, and nobody if a passenger is on the way.
  const { steeredMount, ridesAnyOf } = await import(
    'file://' + path.join(root, 'scripts/relations.js').replace(/\\/g, '/')
  );
  const passenger = make('passenger', 'squire', 0);
  check('the pilot steers its mount', steeredMount(knight)?.id, 'dragon');
  check('a pilot of a pilot steers the root', steeredMount(page)?.id, 'dragon');
  check('a passenger steers nothing', steeredMount(squire), null);
  check('steering a passenger moves nothing', steeredMount(passenger), null);
  check('a token on foot steers nothing', steeredMount(goblin), null);
  check('a mount steers nothing', steeredMount(dragon), null);
  check('rides one of a set', ridesAnyOf(page, new Set(['dragon'])), true);
  check('rides none of a set', ridesAnyOf(page, new Set(['goblin'])), false);
  check('a mount does not ride itself', ridesAnyOf(dragon, new Set(['dragon'])), false);
  check('ids as the keys of an object', ridesAnyOf(knight, { dragon: {} }), true);
  check('no ids at all', ridesAnyOf(knight, undefined), false);

  // dnd5e hands over the tokens it found in the way; ours come out, others stay.
  const placed = doc => ({ document: doc });
  const inTheWay = new Set([placed(knight), placed(squire), placed(goblin)]);
  ignoreOwnMount({}, placed(dragon), {}, inTheWay);
  check('the mount is not stopped by its riders', [...inTheWay].map(t => t.document.id).join(','), 'goblin');
  const before = new Set([placed(dragon), placed(wolf)]);
  ignoreOwnMount({}, placed(goblin), {}, before);
  check('a bystander is still stopped by the mount', before.size, 2);
  let threw = false;
  try { ignoreOwnMount({}, null, {}, new Set([placed(goblin)])); ignoreOwnMount({}, placed(dragon), {}, undefined); } catch { threw = true; }
  check('missing arguments are survived', threw, false);

  globalThis.Hooks = priorHooks;
  globalThis.game = priorGame;
}

// ── Summary ──────────────────────────────────────────────────────────────────
console.log('');
if (failures) {
  console.error(`${failures} check(s) failed.\n`);
  process.exit(1);
}
console.log('All checks passed.\n');
