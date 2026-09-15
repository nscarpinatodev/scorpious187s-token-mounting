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
