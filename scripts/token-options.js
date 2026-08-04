import {
  MODULE_ID, SETTING_MAX_RIDERS, SETTING_GRANT_OWNERSHIP, SETTING_DRAG_TO_MOUNT,
} from './constants.js';

/**
 * Per-token mounting options.
 *
 * Every option resolves through the world setting when the token says nothing,
 * so an unconfigured token behaves exactly as it did before these existed. That
 * matters for the two booleans in particular: defaulting them to "no" would
 * silently stop every existing token being mountable.
 *
 * Stored on the TokenDocument rather than the actor, because two tokens of the
 * same actor can legitimately differ — the wagon being driven has seats, the one
 * in the background is scenery.
 */

export const FLAG_CAPACITY = 'capacity';
export const FLAG_MOUNTABLE = 'mountable';
export const FLAG_RIDEABLE = 'rideable';
export const FLAG_DRAG_MOUNT = 'dragMount';
export const FLAG_GRANT_MODE = 'grantMode';

/**
 * Values for the per-token overrides.
 *
 * A three-way override rather than a checkbox, because a checkbox cannot say
 * "I have no opinion" — and without that, saving a token config once would
 * pin every option to whatever the box happened to show and detach it from the
 * world setting forever.
 */
export const OPTION_DEFAULT = 'default';
export const OPTION_ALWAYS = 'always';
export const OPTION_NEVER = 'never';

function worldSetting(key, fallback) {
  try {
    const value = game.settings.get(MODULE_ID, key);
    return value ?? fallback;
  } catch {
    // Settings are unavailable before `init` and in tests.
    return fallback;
  }
}

/**
 * How many riders this token seats.
 * A per-token value wins; anything unusable falls back to the world default.
 */
export function capacityOf(mountDoc) {
  const own = Number(mountDoc?.getFlag(MODULE_ID, FLAG_CAPACITY));
  if (Number.isFinite(own) && own > 0) return Math.floor(own);
  const world = Number(worldSetting(SETTING_MAX_RIDERS, 8));
  return Number.isFinite(world) && world > 0 ? Math.floor(world) : 8;
}

/**
 * May anything ride this token at all?
 *
 * Opt-in: unset means **no**. Mounts are the exception on a populated scene, so
 * an opt-out default would make every shopkeeper and every wolf a legal mount
 * and — with drag-to-mount on — a legal drop target. Detection sets this
 * automatically for creatures that read as mounts (see mount-detection.js), so
 * the common case still costs no clicks.
 *
 * This is the one option whose default is not "behave as before": existing
 * tokens in an existing world become unmountable until marked.
 */
export function isMountable(mountDoc) {
  return mountDoc?.getFlag(MODULE_ID, FLAG_MOUNTABLE) === true;
}

/**
 * May this token ride anything? Unset means yes — riders are the rule, not the
 * exception, and this exists to exclude the occasional siege engine.
 */
export function isRideable(riderDoc) {
  return riderDoc?.getFlag(MODULE_ID, FLAG_RIDEABLE) !== false;
}

/** Resolve a three-way per-token override against its world setting. */
function resolveOverride(tokenDoc, flagKey, settingKey, fallback) {
  const mode = tokenDoc?.getFlag(MODULE_ID, flagKey);
  if (mode === OPTION_ALWAYS) return true;
  if (mode === OPTION_NEVER) return false;
  return worldSetting(settingKey, fallback) === true;
}

/**
 * Does dragging a token onto this one mount it?
 *
 * Off by default at the world level, because with it on every mountable token
 * becomes a drop target and walking a token across a stabled horse puts it in
 * the saddle. A token can opt in on its own, or opt out of a world-wide yes.
 *
 * Still gated on `mountable`: a token nothing may ride is not made rideable by
 * being dragged onto.
 */
export function acceptsDragMount(mountDoc) {
  if (!isMountable(mountDoc)) return false;
  return resolveOverride(mountDoc, FLAG_DRAG_MOUNT, SETTING_DRAG_TO_MOUNT, false);
}

/**
 * Should mounting this token hand control to the rider's owners?
 * Per-token override of the world setting — a party horse can give up the
 * reins while a plot-critical dragon never does.
 */
export function grantsOwnership(mountDoc) {
  return resolveOverride(mountDoc, FLAG_GRANT_MODE, SETTING_GRANT_OWNERSHIP, true);
}
