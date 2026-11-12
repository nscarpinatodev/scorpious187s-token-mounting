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

/**
 * Update fragments that remove data, in whichever form the running core accepts.
 *
 * Revoking a grant means taking a user's key *out* of the actor's ownership,
 * and a plain update cannot do that: Foundry diffs an object field against what
 * it holds and merges the difference, so a key missing from the update is
 * simply kept. Sending the ownership map with the user deleted from it — which
 * is what this used to do — left every granted OWNER in place.
 *
 * Deleting just that one key does not work either. Ownership validates every
 * value as an ownership level, so a deletion marker inside it fails validation
 * and the whole update is refused. Core's own Ownership dialog replaces the map
 * outright instead, and so does this.
 *
 * v14 spells both operations as operator values; the `==`/`-=` key syntax it
 * deprecates is what v13 understands natively, so that is the fallback.
 */
function replaceField(key, value) {
  const ForcedReplacement = foundry.data?.operators?.ForcedReplacement;
  return ForcedReplacement ? { [key]: ForcedReplacement.create(value) } : { [`==${key}`]: value };
}

/** Remove `key` from the object at dotted path `parent`. */
function deleteKey(parent, key) {
  const ForcedDeletion = foundry.data?.operators?.ForcedDeletion;
  return ForcedDeletion
    ? { [`${parent}.${key}`]: new ForcedDeletion() }
    : { [`${parent}.-=${key}`]: null };
}

const GRANTS_PATH = `flags.${MODULE_ID}.${FLAG_GRANTS}`;

/**
 * Put one user's ownership entry back the way it was before we granted OWNER.
 *
 * Only while it is still the OWNER we granted. If a GM changed this user's level
 * while they were mounted, that was a deliberate decision made after ours, and
 * restoring the pre-mount value over it would quietly undo it.
 */
function restoreEntry(ownership, userId, previous) {
  if (ownership[userId] !== CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER) return;
  if (previous === null || previous === undefined) delete ownership[userId];
  else ownership[userId] = previous;
}

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
  const revoked = [];

  for (const [userId, previous] of Object.entries(grants)) {
    if (stillEntitled.has(userId)) continue;
    restoreEntry(ownership, userId, previous);
    revoked.push(userId);
  }

  if (!revoked.length) return;

  // The grant records need the same care as ownership: sending a smaller
  // `grants` object would merge into the stored one and keep the departed
  // users' entries, and a stale record gets "restored" again later.
  const remaining = Object.keys(grants).filter(id => !revoked.includes(id));
  const flagUpdate = remaining.length
    ? Object.assign({}, ...revoked.map(id => deleteKey(GRANTS_PATH, id)))
    : deleteKey(`flags.${MODULE_ID}`, FLAG_GRANTS);

  await actor.update({ ...replaceField('ownership', ownership), ...flagUpdate });
  log.debug(`revoked mount ownership on "${actor.name}" from ${revoked.length} user(s)`);
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
  for (const [userId, previous] of Object.entries(grants)) restoreEntry(ownership, userId, previous);

  await actor.update({
    ...replaceField('ownership', ownership),
    ...deleteKey(`flags.${MODULE_ID}`, FLAG_GRANTS),
  });
}
