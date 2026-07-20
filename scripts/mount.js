import {
  MODULE_ID, FLAG_MOUNT, SOCKET, MSG_MOUNT, MSG_DISMOUNT, SETTING_MAX_RIDERS,
} from './constants.js';
import { getMount, getRiders, wouldCycle, nextFreeSeat, isMounted } from './relations.js';
import { grantMountOwnership, revokeMountOwnership } from './ownership.js';
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

export function isPrimaryGM() {
  const gms = game.users.filter(u => u.active && u.isGM).map(u => u.id).sort();
  return gms[0] === game.user.id;
}

function maxRiders() {
  try {
    return Number(game.settings.get(MODULE_ID, SETTING_MAX_RIDERS)) || 8;
  } catch {
    return 8;
  }
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
  if (getRiders(mountDoc).length >= maxRiders()) return 'S187TM.Error.Full';
  return null;
}

/** Player-facing entry point. Runs directly if GM, otherwise asks one. */
export async function requestMount(riderDoc, mountDoc) {
  const error = validateMount(riderDoc, mountDoc);
  if (error) {
    ui.notifications.warn(game.i18n.localize(error));
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
  await riderDoc.setFlag(MODULE_ID, FLAG_MOUNT, { tokenId: mountDoc.id, seat });

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

  // Revoke before clearing the flag: revocation inspects the remaining riders
  // to decide whether anyone still justifies each grant, and this rider must
  // still be visible as the one leaving.
  if (mountDoc) await revokeMountOwnership(mountDoc, riderDoc);
  await riderDoc.unsetFlag(MODULE_ID, FLAG_MOUNT);

  log.info(`"${riderDoc.name}" dismounted`);
  Hooks.callAll(`${MODULE_ID}.dismounted`, riderDoc, mountDoc);
}

/**
 * If a mount is deleted its riders would keep a flag pointing at nothing, and
 * its actor would keep widened ownership. Clean both up.
 */
export function registerCleanup() {
  Hooks.on('deleteToken', async (tokenDoc) => {
    if (!game.user.isGM || !isPrimaryGM()) return;
    for (const rider of getRiders(tokenDoc)) {
      await rider.unsetFlag(MODULE_ID, FLAG_MOUNT).catch(() => {});
    }
    const { revokeAllGrants } = await import('./ownership.js');
    await revokeAllGrants(tokenDoc).catch(() => {});
  });
}
