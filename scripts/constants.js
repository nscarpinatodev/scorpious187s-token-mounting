export const MODULE_ID = 'scorpious187s-token-mounting';

/**
 * The rider holds the only authoritative link. A mount's riders are found by
 * scanning the scene for tokens pointing at it, rather than keeping a parallel
 * list on the mount — one source of truth cannot desynchronise from itself,
 * and Rideable's paired flags are a recurring source of orphaned state.
 *
 * Shape: flags[MODULE_ID].mount = { tokenId: string, seat: number }
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
export const SETTING_DEBUG = 'debug';

export const SOCKET = `module.${MODULE_ID}`;

/** Socket message types. Mounting is GM-only; movement deliberately is not. */
export const MSG_MOUNT = 'mount';
export const MSG_DISMOUNT = 'dismount';
export const MSG_MOVE = 'move';

/**
 * Used only if our own carry action could not be registered. `displace` has the
 * right cost and wall semantics but is `teleport: true`, so riders snap instead
 * of travelling with the mount — acceptable as a degraded mode, not as the
 * normal path. See carry-action.js.
 */
export const FALLBACK_ACTION = 'displace';
