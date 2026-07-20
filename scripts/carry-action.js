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
 *   costMultiplier: 0 riding costs nothing
 *   canSelect: false  not something a user picks from the HUD
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
    order: 99,
    teleport: false,
    measure: false,
    walls: null,
    visualize: false,
    canSelect: false,
    terrainAction: null,
    costMultiplier: 0,
    getAnimationOptions: matchMountPace,
  };

  log.debug(`registered movement action "${CARRY_ACTION}"`);
  return true;
}

/**
 * Animate the rider at whatever pace its mount is travelling.
 *
 * Rider and mount cover the same vector at the same moment, so matching speed
 * is what keeps them visually locked together. A fixed speed would drift apart
 * the moment the mount does anything other than walk or fly — swim, crawl and
 * climb all run at half pace.
 *
 * Note this overrides `speedMultiplier` entirely: Foundry ignores that property
 * whenever `getAnimationOptions` is defined.
 */
function matchMountPace(token) {
  const base = CONFIG.Token?.movement?.defaultSpeed ?? 1;

  try {
    const mount = getMount(token);
    const config = CONFIG.Token?.movement?.actions?.[mount?.movementAction];
    const multiplier = config?.speedMultiplier;

    // A teleporting mount (blink/displace) reports Infinity. Matching it means
    // arriving instantly rather than trailing behind at walking pace.
    if (multiplier !== undefined && !Number.isFinite(multiplier)) return { duration: 0 };

    return { movementSpeed: base * (multiplier ?? 1) };
  } catch (err) {
    log.error('failed to match mount pace; using default', err);
    return { movementSpeed: base };
  }
}

/** The action to actually use, preferring ours and degrading gracefully. */
export function carryAction() {
  const actions = CONFIG.Token?.movement?.actions;
  if (actions?.[CARRY_ACTION]) return CARRY_ACTION;
  if (actions?.[FALLBACK_ACTION]) return FALLBACK_ACTION;
  return undefined;
}
