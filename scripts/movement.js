import { MODULE_ID } from './constants.js';
import { carryAction } from './carry-action.js';
import { allRiders, mountLink, isMount } from './relations.js';
import { seatPosition, generateSeats } from './seating.js';
import { ensureLayering } from './layering.js';
import { log } from './logger.js';

/**
 * Carrying riders when their mount moves.
 *
 * Two things make this different from Rideable's approach:
 *
 * 1. No GM in the movement path. Whoever moves the mount already owns it (see
 *    ownership.js), and each rider is carried by a client that already owns
 *    *that* rider. Only riders nobody active owns fall to the GM. So piloting
 *    behaves identically whether or not a GM is logged in — Rideable switches
 *    strategy based on GM presence, which is where its intermittency comes from.
 *
 * 2. Riders move with a purpose-built movement action (see carry-action.js)
 *    that costs nothing, ignores walls the mount already cleared, and — unlike
 *    the built-in `displace` — animates at the mount's own pace rather than
 *    teleporting.
 */

/**
 * Tokens this client is currently carrying. Moving a rider fires updateToken
 * for that rider, and a rider can itself be a mount — without this guard the
 * chain would re-enter and each token would be moved once per level of depth.
 */
const inFlight = new Set();

export function registerMovementSync() {
  Hooks.on('updateToken', (tokenDoc, changed, options) => {
    // Ignore the updates we generated ourselves.
    if (options?.[MODULE_ID]?.carried) return;
    if (inFlight.has(tokenDoc.id)) return;
    if (!positionChanged(changed)) return;
    if (!isMount(tokenDoc)) return;

    carryRiders(tokenDoc).catch(err => log.error('failed to carry riders', err));
  });
}

function positionChanged(changed) {
  // `sort` is included because a mount's draw order changing has to pull its
  // riders back above it, or they end up rendered underneath.
  return ('x' in changed) || ('y' in changed) || ('elevation' in changed) || ('sort' in changed);
}

/**
 * Decide whether *this* client should move a given rider.
 *
 * Every client sees the mount move, so without a deterministic rule several
 * would issue the same update. The rider's own owner is preferred because they
 * certainly have permission; the primary GM covers riders that no active player
 * owns, such as an NPC passenger.
 */
function shouldIMove(riderDoc) {
  const actor = riderDoc.actor;
  const owners = actor
    ? game.users.filter(u => u.active && !u.isGM && actor.testUserPermission(u, 'OWNER'))
    : [];

  if (owners.length) {
    // Deterministic pick: lowest user id among active owners.
    const designated = owners.map(u => u.id).sort()[0];
    return game.user.id === designated;
  }

  if (!game.user.isGM) return false;
  const gms = game.users.filter(u => u.active && u.isGM).map(u => u.id).sort();
  return game.user.id === gms[0];
}

async function carryRiders(mountDoc) {
  // Resolve the whole chain from this mount down, so a passenger on a rider
  // moves too. allRiders is cycle-guarded.
  const riders = allRiders(mountDoc);
  if (!riders.length) return;

  for (const rider of riders) {
    if (!shouldIMove(rider)) continue;

    // The seat is relative to whatever this rider is directly riding, which is
    // not necessarily the token that started the chain.
    const parent = rider.parent?.tokens?.get(mountLink(rider)?.tokenId);
    if (!parent) continue;

    const seatIndex = mountLink(rider)?.seat ?? 0;
    const target = seatPosition(parent, rider, seatFor(parent, seatIndex));

    inFlight.add(rider.id);
    try {
      // Draw order first, so the rider is already above its mount by the time
      // it visibly arrives rather than surfacing a frame later.
      await ensureLayering(rider, parent, seatIndex, { [MODULE_ID]: { carried: true } });
      if (!samePosition(rider, target)) await moveRider(rider, target);
    } catch (err) {
      log.error(`failed to carry rider "${rider.name}"`, err);
    } finally {
      inFlight.delete(rider.id);
    }
  }
}

function samePosition(riderDoc, target) {
  return riderDoc.x === target.x
    && riderDoc.y === target.y
    && (riderDoc.elevation ?? 0) === (target.elevation ?? 0);
}

/** Seat offsets are regenerated from the current rider count. */
function seatFor(mountDoc, seatIndex) {
  const riders = allRiders(mountDoc).length || 1;
  const seats = generateSeats(Math.max(riders, seatIndex + 1));
  return seats[seatIndex] ?? { dx: 0, dy: 0 };
}

async function moveRider(riderDoc, target) {
  const options = {
    [MODULE_ID]: { carried: true },
    // The mount has already paid for this movement and already resolved walls;
    // a passenger must not be re-charged or re-blocked.
    constrainOptions: { ignoreWalls: true, ignoreCost: true },
  };

  // Foundry v13's waypoint API carries the action per movement rather than
  // requiring the token's persistent movementAction to be mutated and restored.
  const action = carryAction();
  if (typeof riderDoc.move === 'function' && action) {
    return riderDoc.move([{ ...target, action, snapped: false }], options);
  }

  // Defensive fallback: if the movement API is absent or renamed, a plain
  // update still puts the rider in the right place, just without displace
  // semantics. Better than the rider silently staying behind.
  log.warn('TokenDocument#move unavailable; falling back to a direct update');
  return riderDoc.update(target, { ...options, animate: false });
}

/** Snap every rider to its seat immediately, without waiting for a move. */
export async function resnap(mountDoc) {
  await carryRiders(mountDoc);
}
