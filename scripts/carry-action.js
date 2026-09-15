import { FALLBACK_ACTION } from './constants.js';
import { getMount } from './relations.js';
import { log } from './logger.js';

/**
 * A purpose-built movement action for carrying riders.
 *
 * The obvious choice is Foundry's built-in `displace`, and it has the right
 * cost semantics — but it is declared `teleport: true`, so a rider snaps
 * instantly to its destination while the mount is still animating there. The
 * rider then visibly sits at the end point of the previous movement until the
 * mount catches up.
 *
 * Registering our own action keeps everything `displace` got right and fixes
 * the part it got wrong:
 *
 *   teleport: false   animate along with the mount instead of snapping
 *   measure: false    a passenger spends none of their own movement
 *   walls: null       the mount already resolved walls; do not re-block
 *   visualize: false  no ruler for someone who is not steering
 *   getCostFunction   riding costs nothing
 *   canSelect         not something a user picks from the HUD
 *
 * Registered in the fully-expanded `TokenMovementActionConfig` form, not the
 * `TokenMovementActionConfigDescriptor` shorthand that v14 core uses for its own
 * actions. v14 normalises the shorthand in `Game##initializeMovementActions`,
 * turning `canSelect: false` into a function, `terrainAction` into
 * `deriveTerrainDifficulty` and `costMultiplier` into `getCostFunction`. v13 has
 * no such pass and reads these fields as-is.
 *
 * That difference is not cosmetic. Core calls `config.canSelect(token)`
 * unguarded while building the Token HUD's movement palette and the Token Config
 * identity tab, so a boolean there throws "canSelect is not a function" on v13
 * and aborts both renders — the symptom being tokens that cannot be right-clicked
 * and settings that will not open, for every token in the world, mounted or not.
 * Because the throw happens inside core's context preparation, it lands before
 * `renderTokenHUD`/`renderTokenConfig` fire, which is why the try/catch guards
 * around our own injections cannot contain it.
 *
 * The expanded form is correct on both: v14's normaliser only fills in fields
 * that are `undefined`, so supplying every one of them makes it a no-op.
 */
export const CARRY_ACTION = 's187Carried';

export function registerCarryAction() {
  const actions = CONFIG.Token?.movement?.actions;
  if (!actions) {
    log.warn('CONFIG.Token.movement.actions unavailable; falling back to displace');
    return false;
  }

  actions[CARRY_ACTION] = {
    label: 'S187TM.Movement.Carried',
    icon: 'fa-solid fa-hands-holding',
    // v13 has no default for `img`, and the HUD prefers it over `icon` whenever
    // it is set, so it has to be an explicit null rather than absent.
    img: null,
    order: 99,
    teleport: false,
    measure: false,
    walls: null,
    visualize: false,
    // A function, not `false`: see the note above. Being carried is a state the
    // module puts a token into, never one a user chooses from the palette.
    canSelect: () => false,
    // The expansion of `terrainAction: null` — carried movement ignores terrain
    // entirely rather than inheriting another action's difficulty.
    deriveTerrainDifficulty: () => 1,
    // The expansion of `costMultiplier: 0`. `measure: false` already zeroes the
    // cost, but the function must exist: v13 calls it without a fallback.
    getCostFunction: () => () => 0,
    getAnimationOptions: matchMountPace,
  };

  log.debug(`registered movement action "${CARRY_ACTION}"`);
  return true;
}

/**
 * The base animation speed of a token, in grid spaces per second, before its
 * action or terrain modify it. Asked of the placeable because a system can
 * override `Token#_getAnimationMovementSpeed`; a token not on the viewed canvas
 * has no placeable, so the world default stands in.
 */
function baseSpeed(tokenDoc) {
  try {
    const own = tokenDoc?.object?._getAnimationMovementSpeed?.({});
    if (Number.isFinite(own) && own > 0) return own;
  } catch { /* fall through to the default */ }
  return CONFIG.Token?.movement?.defaultSpeed ?? 6;
}

/**
 * How fast a token animates one segment travelled with `action`, in grid spaces
 * per second. `Infinity` means the segment is instant.
 *
 * This mirrors core's own resolution in `Token##animate` and
 * `Token#_getAnimationDuration` rather than reading any one property of the
 * action config: the action's `getAnimationOptions` supplies `duration`,
 * `movementSpeed` or `speedMultiplier` — whichever it declares — and terrain
 * difficulty divides the result, capped at 10.
 *
 * Reading `config.speedMultiplier` directly, as this used to, silently did
 * nothing on v14: the normaliser folds that property into
 * `getAnimationOptions` and then deletes it, so every mount looked like it was
 * walking and riders on a swimming or teleporting mount drifted away from it.
 */
export function segmentSpeed(tokenDoc, action, terrain = null) {
  const config = CONFIG.Token?.movement?.actions?.[action];
  const defaults = typeof config?.getAnimationOptions === 'function'
    ? (config.getAnimationOptions(tokenDoc) ?? {})
    : {};

  if (defaults.duration === 0) return Infinity;

  let speed = Number.isFinite(defaults.movementSpeed) ? defaults.movementSpeed : baseSpeed(tokenDoc);
  speed *= defaults.speedMultiplier ?? 1;

  const difficulty = terrain?.difficulty;
  if (Number.isFinite(difficulty) && difficulty > 0) speed /= Math.min(difficulty, 10);

  return speed > 0 ? speed : Infinity;
}

/**
 * How long a token's movement animation takes, in milliseconds, summed segment
 * by segment exactly as core animates it: from `movement.origin` through every
 * passed waypoint, intermediates included, each at its own action's pace and
 * over its own terrain.
 *
 * Measured against the token's own scene rather than `canvas.dimensions`, since
 * the client doing the work may be looking at a different scene entirely.
 *
 * Rotation is deliberately left out. Riders are carried with the mount's
 * auto-rotate decision, so they turn through the same angles at core's fixed
 * rotation speed and spend that time themselves.
 *
 * @returns {number|undefined} Undefined when the movement cannot be measured.
 */
export function movementDuration(tokenDoc, movement) {
  const origin = movement?.origin;
  const waypoints = movement?.passed?.waypoints;
  if (!origin || !Array.isArray(waypoints) || !waypoints.length) return undefined;

  const scene = tokenDoc?.parent;
  const size = scene?.dimensions?.size ?? scene?.grid?.size;
  const distancePixels = scene?.dimensions?.distancePixels
    ?? (size && scene?.grid?.distance ? size / scene.grid.distance : undefined);
  if (!size || !distancePixels) return undefined;

  let total = 0;
  let from = origin;
  for (const to of waypoints) {
    const speed = segmentSpeed(tokenDoc, to.action ?? tokenDoc.movementAction, to.terrain);
    if (Number.isFinite(speed)) total += segmentLength(from, to, size, distancePixels) / speed * 1000;
    from = to;
  }
  return total;
}

/** Core's movement animation distance: travel in grid spaces, or half the resize, whichever is larger. */
function segmentLength(from, to, size, distancePixels) {
  const d = (key) => (from[key] ?? 0) - (to[key] ?? from[key] ?? 0);
  const travel = Math.hypot(d('x'), d('y'), d('elevation') * distancePixels) / size;
  const resize = Math.hypot(d('width'), d('height'), d('depth')) * 0.5;
  return Math.max(travel, resize);
}

/** Riders whose pace is being resolved, so a corrupted mount cycle cannot recurse forever. */
const resolving = new Set();

/**
 * Default animation pace for a carried rider: whatever its mount is travelling at.
 *
 * This is the fallback. A rider carried along a mount's route is also given the
 * mount's total animation duration (see movement.js), and core converts that
 * into one speed for the whole route, which wins over anything returned here.
 * That is what keeps them together on a route that mixes actions or crosses
 * difficult terrain — a single default pace cannot, because core asks for it
 * with only the rider, never the segment.
 *
 * Only absolute values are returned. A `speedMultiplier` here would be applied
 * on top of that duration-derived speed and throw the two back out of step.
 *
 * The mount's pace comes from the actions it actually travelled with in its
 * latest movement, not its stored default action, which a ruler drag can
 * override. A mount that is itself being carried resolves through its own
 * `s187Carried` action to the token beneath it, so a passenger on a knight on
 * a dragon moves at dragon pace.
 */
function matchMountPace(token) {
  if (!token?.id || resolving.has(token.id)) return {};
  resolving.add(token.id);

  try {
    const mount = getMount(token);
    if (!mount) return {};

    const travelled = mount.movement?.passed?.waypoints;
    const actions = Array.isArray(travelled) && travelled.length
      ? travelled.map(waypoint => waypoint.action ?? mount.movementAction)
      : [mount.movementAction];

    // Instant only if every segment was; otherwise the pace of the last segment
    // that actually animated, so a blink partway along does not freeze a walk.
    const speeds = actions.map(action => segmentSpeed(mount, action));
    const moving = speeds.filter(Number.isFinite);
    if (!moving.length) return { duration: 0 };
    return { movementSpeed: moving[moving.length - 1] };
  } catch (err) {
    log.error('failed to match mount pace; using default', err);
    return {};
  } finally {
    resolving.delete(token.id);
  }
}

/** The action to actually use, preferring ours and degrading gracefully. */
export function carryAction() {
  const actions = CONFIG.Token?.movement?.actions;
  if (actions?.[CARRY_ACTION]) return CARRY_ACTION;
  if (actions?.[FALLBACK_ACTION]) return FALLBACK_ACTION;
  return undefined;
}
