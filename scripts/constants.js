export const MODULE_ID = 'scorpious187s-token-mounting';

/**
 * The rider holds the only authoritative link. A mount's riders are found by
 * scanning the scene for tokens pointing at it, rather than keeping a parallel
 * list on the mount — one source of truth cannot desynchronise from itself,
 * and Rideable's paired flags are a recurring source of orphaned state.
 *
 * Shape: flags[MODULE_ID].mount = { tokenId: string, seat: number, sort: number }
 *
 * `sort` is the rider's draw order from *before* it mounted. Mounting raises it
 * above the mount (see layering.js), so without recording the original the
 * rider would stay permanently raised after stepping off.
 */
export const FLAG_MOUNT = 'mount';

/**
 * Ownership levels replaced when a rider mounted, so dismounting can restore
 * exactly what was there rather than guessing at a default.
 * Shape: flags[MODULE_ID].grants = { [userId]: previousLevel|null }
 * Stored on the mount's *actor*, since that is where token permission lives.
 */
export const FLAG_GRANTS = 'grants';

export const SETTING_GRANT_OWNERSHIP = 'grantOwnership';
export const SETTING_MAX_RIDERS = 'maxRiders';
export const SETTING_DRAG_TO_MOUNT = 'dragToMount';
export const SETTING_DETECT_MOUNTS = 'detectMounts';
export const SETTING_MOUNT_NAMES = 'mountNames';
export const SETTING_DEBUG = 'debug';

/**
 * dnd5e-only settings. Registered unconditionally so `game.settings.get` always
 * resolves, but only shown in the config UI when dnd5e is the active system —
 * an Animal Handling check means nothing in Fallout or PF2e.
 */
export const SETTING_HOSTILE_CHECK = 'hostileCheck';
export const SETTING_HOSTILE_DC = 'hostileCheckDC';

export const SOCKET = `module.${MODULE_ID}`;

/**
 * Socket message types. Mounting is GM-only; movement deliberately is not, and
 * there is no move message — with ownership grants off a GM drives the mount
 * directly rather than relaying a player's steering.
 */
export const MSG_MOUNT = 'mount';
export const MSG_DISMOUNT = 'dismount';

/**
 * Used only if our own carry action could not be registered. `displace` has the
 * right cost and wall semantics but is `teleport: true`, so riders snap instead
 * of travelling with the mount — acceptable as a degraded mode, not as the
 * normal path. See carry-action.js.
 */
export const FALLBACK_ACTION = 'displace';
