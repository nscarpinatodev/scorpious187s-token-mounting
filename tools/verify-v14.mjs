/**
 * Verify the carry action against a real Foundry v14 installation.
 *
 * Run with `node tools/verify-v14.mjs`, or point it somewhere explicitly:
 *   node tools/verify-v14.mjs "C:/Program Files/Foundry Virtual Tabletop/resources/app"
 *   FOUNDRY_APP=/path/to/resources/app node tools/verify-v14.mjs
 *
 * Why this exists
 * ---------------
 * The module supports two generations that disagree about how a movement action
 * is declared. v14 accepts a shorthand `TokenMovementActionConfigDescriptor` and
 * expands it in `Game##initializeMovementActions`; v13 has no such pass and
 * reads the canonical `TokenMovementActionConfig` fields as written. Shipping
 * the shorthand is what broke v13 — core calls `canSelect(token)` unguarded
 * while building the Token HUD and Token Config, so a boolean there threw and
 * took right-click and the token settings sheet down with it.
 *
 * carry-action.js therefore registers the canonical form, which is correct on
 * v13 *and* passes through v14's normaliser untouched. tools/check.mjs pins that
 * statically. This goes further and proves it dynamically: it extracts the real
 * normaliser and the real core action descriptors out of an installed v14 and
 * runs the module's actual config through them.
 *
 * Skips cleanly (exit 0) when no v14 install is present, so it never blocks a
 * build on a machine that only has v13.
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const BACKSLASH = String.fromCharCode(92);

let failures = 0;
const fail = msg => { console.error(`  FAIL  ${msg}`); failures++; };
const pass = msg => console.log(`  ok    ${msg}`);

/* ── Locate an installed v14 ────────────────────────────────────────────────*/

function candidates() {
  const found = [];
  const arg = process.argv[2];
  if (arg) found.push(arg);
  if (process.env.FOUNDRY_APP) found.push(process.env.FOUNDRY_APP);
  found.push(
    'C:/Program Files/Foundry Virtual Tabletop/resources/app',
    '/Applications/Foundry Virtual Tabletop.app/Contents/Resources/app',
  );
  // Sibling node installs: FoundryVTT-Node-14.x next to a drive root.
  for (const drive of ['C:', 'D:', 'E:', 'F:']) {
    let entries = [];
    try {
      entries = fs.readdirSync(`${drive}/`, { withFileTypes: true });
    } catch { continue; }
    for (const entry of entries) {
      if (entry.isDirectory() && /^FoundryVTT-Node-/i.test(entry.name)) {
        found.push(`${drive}/${entry.name}`);
      }
    }
  }
  return [...new Set(found)];
}

function generationOf(appRoot) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8'));
    return pkg?.release ?? null;
  } catch { return null; }
}

/* ── Extract the real core pieces ───────────────────────────────────────────*/

/** The balanced `{...}` block starting at the first brace at or after `from`. */
function block(src, from) {
  const start = src.indexOf('{', from);
  if (start < 0) throw new Error('no block found');
  let depth = 0;
  let inString = null;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    const prev = src[i - 1];
    if (inString) {
      if (c === inString && prev !== BACKSLASH) inString = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inString = c; continue; }
    if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i) + 1; continue; }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error('unbalanced block');
}

const deepFreeze = obj => {
  Object.freeze(obj);
  for (const value of Object.values(obj)) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) deepFreeze(value);
  }
  return obj;
};

/* ── The check ──────────────────────────────────────────────────────────────*/

async function verify(appRoot) {
  const release = generationOf(appRoot);
  if (!release) return false;
  if (Number(release.generation) < 14) {
    console.log(`\nSkipping ${appRoot} — generation ${release.generation}, not v14.`);
    return false;
  }

  console.log(`\nFoundry ${release.generation}.${release.build} — ${appRoot}`);

  const gameSrc = fs.readFileSync(path.join(appRoot, 'client/game.mjs'), 'utf8');
  const configSrc = fs.readFileSync(path.join(appRoot, 'client/config.mjs'), 'utf8');

  // Core's own action descriptors, and the normaliser that expands them.
  const literal = block(configSrc, configSrc.indexOf('actions: {', configSrc.indexOf('movement: {')));
  const coreActions = () => (0, eval)(`(${literal})`);
  const body = block(gameSrc, gameSrc.indexOf('#initializeMovementActions() {')).slice(1, -1);
  const normalize = new Function('CONFIG', 'foundry', body);

  // Register the module's real config, exactly as it does at `init`.
  const actions = coreActions();
  const before = Object.keys(actions).length;
  globalThis.CONFIG = { Token: { movement: { actions, defaultAction: 'walk', defaultSpeed: 6 } } };

  const { registerCarryAction, CARRY_ACTION, segmentSpeed } = await import(
    `${pathToFileURL(path.join(root, 'scripts/carry-action.js')).href}?v14=${release.build}`
  );
  registerCarryAction();

  const raw = { ...actions[CARRY_ACTION] };
  const rawAnimation = actions[CARRY_ACTION].getAnimationOptions;

  // The normaliser also validates the whole set; letting it throw is a result.
  try {
    normalize(globalThis.CONFIG, { utils: { deepFreeze } });
    pass('v14 normalisation completes without throwing');
  } catch (err) {
    fail(`v14 normalisation threw — ${err.message}`);
    return true;
  }

  const config = globalThis.CONFIG.Token.movement.actions[CARRY_ACTION];
  if (!config) {
    fail(`${CARRY_ACTION} did not survive normalisation`);
    return true;
  }
  pass(`${CARRY_ACTION} survives alongside ${before} core actions`);

  const check = (label, actual, expected) => {
    if (actual === expected) pass(`${label} → ${actual}`);
    else fail(`${label} → got ${actual}, expected ${expected}`);
  };

  // The point of the whole exercise: normalisation changed nothing.
  for (const key of ['label', 'icon', 'img', 'order', 'teleport', 'measure', 'walls', 'visualize']) {
    check(`${key} passed through unchanged`, config[key], raw[key]);
  }
  check('getAnimationOptions is still ours', config.getAnimationOptions === rawAnimation, true);
  check('canSelect is still ours', config.canSelect === raw.canSelect, true);
  check('getCostFunction is still ours', config.getCostFunction === raw.getCostFunction, true);
  check('deriveTerrainDifficulty is still ours',
    config.deriveTerrainDifficulty === raw.deriveTerrainDifficulty, true);

  // Behaviour through the v14 call sites, all of which use canSelect in boolean
  // position only — so falsy is the contract, not any particular falsy value.
  const token = { movementAction: 'walk' };
  check('carried is unselectable', !config.canSelect(token), true);
  check('carried costs nothing', config.getCostFunction(token, {})(5, {}), 0);
  check('carried ignores terrain', config.deriveTerrainDifficulty({ walk: 3, fly: 2 }), 1);

  // Mount pace against core's own actions after normalisation. v14 deletes the
  // `speedMultiplier` property these used to be read from, so this is the check
  // that riders on a swimming, climbing or teleporting mount keep up with it.
  const base = globalThis.CONFIG.Token.movement.defaultSpeed;
  const expected = {
    walk: base, fly: base, burrow: base, jump: base,
    swim: base / 2, crawl: base / 2, climb: base / 2,
    blink: Infinity, displace: Infinity,
  };
  for (const [action, speed] of Object.entries(expected)) {
    if (!(action in globalThis.CONFIG.Token.movement.actions)) continue;
    check(`mount pace: ${action}`, segmentSpeed({}, action), speed);
  }

  return true;
}

/* ── Drive ──────────────────────────────────────────────────────────────────*/

console.log('v14 movement action verification');

let verified = 0;
for (const candidate of candidates()) {
  if (!fs.existsSync(path.join(candidate, 'client/game.mjs'))) continue;
  try {
    if (await verify(candidate)) verified++;
  } catch (err) {
    fail(`${candidate} — ${err.message}`);
  }
}

console.log('');
if (!verified) {
  console.log('No Foundry v14 installation found; skipping.');
  console.log('Pass a path or set FOUNDRY_APP to verify against one.\n');
  process.exit(0);
}
if (failures) {
  console.error(`${failures} check(s) failed across ${verified} installation(s).\n`);
  process.exit(1);
}
console.log(`All checks passed against ${verified} v14 installation(s).\n`);
