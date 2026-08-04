import {
  MODULE_ID, FLAG_MOUNT, SOCKET, MSG_MOUNT, MSG_DISMOUNT,
} from './constants.js';
import { capacityOf, isMountable, isRideable } from './token-options.js';
import {
  getMount, getRiders, wouldCycle, nextFreeSeat, isMounted, mountLink,
} from './relations.js';
import { grantMountOwnership, revokeMountOwnership, revokeAllGrants } from './ownership.js';
import { restoreSort } from './layering.js';
import { resnap } from './movement.js';
import { log } from './logger.js';

/**
 * Mounting and dismounting.
 *
 * These are GM-only operations because they change actor ownership, and they
 * are the *only* thing routed through the GM. Mounting happens once; movement
 * happens constantly. Putting the GM in the rare path and keeping them out of
 * the frequent one is the whole design.
 */

export function registerMountSocket() {
  game.socket.on(SOCKET, async payload => {
    if (!game.user.isGM) return;
    // Only the primary GM acts, or a three-GM table would run it three times.
    if (!isPrimaryGM()) return;

    try {
      const scene = game.scenes.get(payload.sceneId);
      const rider = scene?.tokens?.get(payload.riderId);
      if (!rider) return;

      // The socket is the one place a client asks us to write on its behalf, so
      // it is the one place the server's own permission check does not apply —
      // the write lands under GM credentials no matter who asked for it. Verify
      // the request the way Foundry would have if the user had made the change
      // themselves, or any client can mount any token onto any other.
      if (!mayControl(payload.userId, rider)) {
        log.warn(`refused ${payload.type}: user "${payload.userId}" does not own "${rider.name}"`);
        return;
      }

      if (payload.type === MSG_MOUNT) {
        const mount = scene.tokens.get(payload.mountId);
        if (mount) await performMount(rider, mount, payload.userId);
      } else if (payload.type === MSG_DISMOUNT) {
        await performDismount(rider);
      }
    } catch (err) {
      log.error('socket handler failed', err);
    }
  });
}

/**
 * May this user mount or dismount this token?
 *
 * Ownership of the *rider* is the whole test. Owning the mount is deliberately
 * not required — riding an NPC horse you do not own is the ordinary case, and
 * granting that ownership is exactly what mounting is for.
 */
function mayControl(userId, tokenDoc) {
  const user = game.users.get(userId);
  if (!user) return false;
  if (user.isGM) return true;
  return tokenDoc.actor?.testUserPermission(user, 'OWNER') ?? false;
}

export function isPrimaryGM() {
  const gms = game.users.filter(u => u.active && u.isGM).map(u => u.id).sort();
  return gms[0] === game.user.id;
}

/**
 * Validate a mounting request. Returns an error key, or null if allowed.
 * Shared by the requesting client and the GM so a player gets immediate
 * feedback instead of a silent no-op after a round trip.
 */
export function validateMount(riderDoc, mountDoc) {
  if (!riderDoc || !mountDoc) return 'S187TM.Error.Missing';
  if (riderDoc.id === mountDoc.id) return 'S187TM.Error.Self';
  if (riderDoc.parent?.id !== mountDoc.parent?.id) return 'S187TM.Error.DifferentScene';
  if (isMounted(riderDoc)) return 'S187TM.Error.AlreadyMounted';
  if (wouldCycle(riderDoc, mountDoc)) return 'S187TM.Error.Cycle';
  if (!isRideable(riderDoc)) return 'S187TM.Error.CannotRide';
  if (!isMountable(mountDoc)) return 'S187TM.Error.NotMountable';
  if (getRiders(mountDoc).length >= capacityOf(mountDoc)) return 'S187TM.Error.Full';
  return null;
}

/**
 * Are these two tokens hostile to one another?
 *
 * Exposed for gate handlers, which is the common case for wanting one: an
 * unwilling mount has to be subdued before it can be ridden.
 */
export function isHostile(riderDoc, mountDoc) {
  const levels = CONST.TOKEN_DISPOSITIONS;
  const rider = riderDoc?.disposition;
  const mount = mountDoc?.disposition;
  if (rider === undefined || mount === undefined) return false;
  return (rider === levels.FRIENDLY && mount === levels.HOSTILE)
    || (rider === levels.HOSTILE && mount === levels.FRIENDLY);
}

/**
 * The asynchronous half of mount validation.
 *
 * `validateMount` answers questions that can be settled by inspecting state.
 * This one exists for the questions that cannot — rolling a check, or asking
 * someone — which is what subduing a hostile mount requires.
 *
 * A handler either denies outright by setting `allowed = false`, or pushes a
 * promise onto `checks` and resolves it with `false` to deny once it knows.
 * Pushing rather than returning is what lets the hook stay synchronous while
 * the work behind it is not.
 *
 * Deliberately run on the *requesting* client, not the GM's: the player rolling
 * to control the animal should be the one who sees the dice. That does mean a
 * modified client could skip it, which is the usual trade at a table where
 * everyone can already edit their own sheet.
 */
export async function mountAllowed(riderDoc, mountDoc) {
  const gate = { allowed: true, reason: null, checks: [] };

  Hooks.callAll(`${MODULE_ID}.preMount`, riderDoc, mountDoc, gate);
  if (!gate.allowed) return gate;

  const results = await Promise.all(gate.checks);
  if (results.some(result => result === false)) {
    gate.allowed = false;
    gate.reason ??= 'S187TM.Error.Refused';
  }
  return gate;
}

/** Player-facing entry point. Runs directly if GM, otherwise asks one. */
export async function requestMount(riderDoc, mountDoc) {
  const error = validateMount(riderDoc, mountDoc);
  if (error) {
    ui.notifications.warn(game.i18n.localize(error));
    return false;
  }

  const gate = await mountAllowed(riderDoc, mountDoc);
  if (!gate.allowed) {
    ui.notifications.warn(game.i18n.localize(gate.reason ?? 'S187TM.Error.Refused'));
    return false;
  }

  if (game.user.isGM) {
    await performMount(riderDoc, mountDoc, game.user.id);
    return true;
  }

  if (!game.users.some(u => u.active && u.isGM)) {
    ui.notifications.warn(game.i18n.localize('S187TM.Error.NoGM'));
    return false;
  }

  game.socket.emit(SOCKET, {
    type: MSG_MOUNT,
    sceneId: riderDoc.parent.id,
    riderId: riderDoc.id,
    mountId: mountDoc.id,
    userId: game.user.id,
  });
  return true;
}

export async function requestDismount(riderDoc) {
  if (!isMounted(riderDoc)) return false;

  if (game.user.isGM) {
    await performDismount(riderDoc);
    return true;
  }

  if (!game.users.some(u => u.active && u.isGM)) {
    ui.notifications.warn(game.i18n.localize('S187TM.Error.NoGM'));
    return false;
  }

  game.socket.emit(SOCKET, {
    type: MSG_DISMOUNT,
    sceneId: riderDoc.parent.id,
    riderId: riderDoc.id,
    userId: game.user.id,
  });
  return true;
}

/** GM-side. Establishes the link, grants ownership, seats the rider. */
export async function performMount(riderDoc, mountDoc, requestingUserId) {
  const error = validateMount(riderDoc, mountDoc);
  if (error) {
    log.warn(`refused mount: ${error}`);
    return;
  }

  const seat = nextFreeSeat(mountDoc);
  // Capture the rider's draw order before anything raises it, so dismounting
  // can put it back instead of leaving the rider above where it started.
  await riderDoc.setFlag(MODULE_ID, FLAG_MOUNT, {
    tokenId: mountDoc.id,
    seat,
    sort: riderDoc.sort,
  });

  // Ownership before positioning: the requesting player should already be able
  // to drive the mount by the time their rider visibly lands on it.
  await grantMountOwnership(mountDoc, riderDoc);
  await resnap(mountDoc);

  log.info(`"${riderDoc.name}" mounted "${mountDoc.name}" (seat ${seat})`);
  Hooks.callAll(`${MODULE_ID}.mounted`, riderDoc, mountDoc, seat, requestingUserId);
}

/** GM-side. Removes the link and restores ownership. */
export async function performDismount(riderDoc) {
  const mountDoc = getMount(riderDoc);
  // Read before unsetting: the prior draw order lives on the flag we are about
  // to remove.
  const priorSort = mountLink(riderDoc)?.sort;

  // Revoke before clearing the flag: revocation inspects the remaining riders
  // to decide whether anyone still justifies each grant, and this rider must
  // still be visible as the one leaving.
  if (mountDoc) await revokeMountOwnership(mountDoc, riderDoc);
  await riderDoc.unsetFlag(MODULE_ID, FLAG_MOUNT);
  await restoreSort(riderDoc, priorSort);

  log.info(`"${riderDoc.name}" dismounted`);
  Hooks.callAll(`${MODULE_ID}.dismounted`, riderDoc, mountDoc);
}

/**
 * A deleted token strands state at whichever end of the link it was on, so both
 * have to be cleaned up.
 *
 * Deleting a *mount* leaves its riders holding a flag that points at nothing and
 * its actor holding ownership widened for riders that are no longer aboard.
 * Deleting a *rider* leaves a grant on its mount that nobody justifies any more
 * — silently, since nothing else revokes outside of dismount.
 */
export function registerCleanup() {
  Hooks.on('deleteToken', async (tokenDoc) => {
    if (!game.user.isGM || !isPrimaryGM()) return;

    // The deleted token was a mount.
    for (const rider of getRiders(tokenDoc)) {
      const priorSort = mountLink(rider)?.sort;
      await rider.unsetFlag(MODULE_ID, FLAG_MOUNT).catch(() => {});
      await restoreSort(rider, priorSort).catch(() => {});
    }
    await revokeAllGrants(tokenDoc).catch(() => {});

    // The deleted token was a rider. It is already out of the scene collection
    // by the time this hook runs, so revocation sees exactly the riders that
    // remain and withdraws only what none of them still justifies.
    const mountDoc = getMount(tokenDoc);
    if (mountDoc) await revokeMountOwnership(mountDoc, tokenDoc).catch(() => {});
  });
}
