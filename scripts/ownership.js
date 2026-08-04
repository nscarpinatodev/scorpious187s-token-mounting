import { MODULE_ID, FLAG_GRANTS } from './constants.js';
import { getRiders } from './relations.js';
import { grantsOwnership } from './token-options.js';
import { log } from './logger.js';

/**
 * Ownership handling — the point of the whole design.
 *
 * A player cannot move a token they do not own: the *server* rejects the
 * update, so no amount of client-side trickery helps. Rideable works around
 * this by relaying every movement through the GM's client, which puts a network
 * round-trip and another user's browser in the path of every step, and changes
 * behaviour depending on whether a GM is logged in.
 *
 * Instead this grants the rider's owners real ownership of the mount when they
 * mount, so movement is a direct, ordinary token update. The GM is involved
 * once, at mount time, rather than continuously.
 *
 * The cost, and it is a real one: Foundry resolves token permission through the
 * actor (`TokenDocument#testUserPermission` delegates straight to
 * `Actor#testUserPermission`). There is no token-only permission to grant, so
 * an owner of the mount also gets its character sheet, HP and rolls. For a
 * dragon its rider commands that is usually correct; where it is not, the
 * grantOwnership setting turns this off and falls back to GM relay.
 *
 * Prior levels are recorded so dismounting restores exactly what was there,
 * rather than assuming a default and quietly widening or removing access.
 */

/** Users who own the rider and should therefore be able to drive the mount. */
function ridersOwners(riderDoc) {
  const actor = riderDoc?.actor;
  if (!actor) return [];
  return game.users.filter(u => !u.isGM && actor.testUserPermission(u, 'OWNER'));
}

/**
 * Grant mount ownership to the rider's owners. GM-only.
 * @returns {Promise<void>}
 */
export async function grantMountOwnership(mountDoc, riderDoc) {
  // Resolved per mount: the world setting is only the fallback when this
  // particular token has no opinion of its own.
  if (!game.user.isGM || !grantsOwnership(mountDoc)) return;

  const actor = mountDoc?.actor;
  if (!actor) return;

  const users = ridersOwners(riderDoc);
  if (!users.length) return;

  const grants = foundry.utils.deepClone(actor.getFlag(MODULE_ID, FLAG_GRANTS) ?? {});
  const ownership = foundry.utils.deepClone(actor.ownership ?? {});
  let changed = false;

  for (const user of users) {
    const current = ownership[user.id] ?? null;
    if (current === CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER) continue; // already owns it

    // Record the prior level only the first time, so a second rider mounting
    // does not overwrite the original value with an already-granted OWNER.
    if (!(user.id in grants)) grants[user.id] = current;
    ownership[user.id] = CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER;
    changed = true;
  }

  if (!changed) return;

  await actor.update({ ownership, [`flags.${MODULE_ID}.${FLAG_GRANTS}`]: grants });
  log.debug(`granted mount ownership on "${actor.name}" to ${users.map(u => u.name).join(', ')}`);
}

/**
 * Revoke grants for a rider that is dismounting, restoring prior levels.
 *
 * A grant is only withdrawn when no *remaining* rider justifies it — otherwise
 * one passenger stepping off would strip control from the pilot still aboard.
 */
export async function revokeMountOwnership(mountDoc, leavingRiderDoc) {
  if (!game.user.isGM) return;

  const actor = mountDoc?.actor;
  if (!actor) return;

  const grants = foundry.utils.deepClone(actor.getFlag(MODULE_ID, FLAG_GRANTS) ?? {});
  if (!Object.keys(grants).length) return;

  // Users still entitled to the mount through some other rider.
  const stillEntitled = new Set();
  for (const rider of getRiders(mountDoc)) {
    if (rider.id === leavingRiderDoc?.id) continue;
    for (const user of ridersOwners(rider)) stillEntitled.add(user.id);
  }

  const ownership = foundry.utils.deepClone(actor.ownership ?? {});
  let changed = false;

  for (const [userId, previous] of Object.entries(grants)) {
    if (stillEntitled.has(userId)) continue;

    if (previous === null || previous === undefined) delete ownership[userId];
    else ownership[userId] = previous;

    delete grants[userId];
    changed = true;
  }

  if (!changed) return;

  const update = { ownership };
  if (Object.keys(grants).length) update[`flags.${MODULE_ID}.${FLAG_GRANTS}`] = grants;
  else update[`flags.${MODULE_ID}.-=${FLAG_GRANTS}`] = null;

  await actor.update(update);
  log.debug(`revoked mount ownership on "${actor.name}"`);
}

/**
 * Clear every grant on a mount regardless of riders. Used when the module is
 * disabled or a scene is cleaned up, so ownership is never left widened.
 */
export async function revokeAllGrants(mountDoc) {
  if (!game.user.isGM) return;
  const actor = mountDoc?.actor;
  const grants = actor?.getFlag(MODULE_ID, FLAG_GRANTS);
  if (!grants || !Object.keys(grants).length) return;

  const ownership = foundry.utils.deepClone(actor.ownership ?? {});
  for (const [userId, previous] of Object.entries(grants)) {
    if (previous === null || previous === undefined) delete ownership[userId];
    else ownership[userId] = previous;
  }

  await actor.update({ ownership, [`flags.${MODULE_ID}.-=${FLAG_GRANTS}`]: null });
}
