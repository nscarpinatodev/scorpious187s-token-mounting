import { MODULE_ID } from './constants.js';
import { mountLink, getMount } from './relations.js';
import { acceptsDragMount, isRideable } from './token-options.js';
import { requestMount, validateMount } from './mount.js';
import { realWaypoints } from './movement.js';
import { log } from './logger.js';

/**
 * Steering a mount by moving the pilot, and mounting by dragging.
 *
 * Both hang off `preMoveToken`, which can veto a movement outright. That is the
 * only place a drag can be turned into something other than a drag — by the time
 * `moveToken` fires the move has already happened.
 *
 * The pilot is whoever holds seat 0. Seats are assigned lowest-free-first, so
 * that is the first token to mount, and seating.js already treats seat 0 as the
 * driving position. Passengers are blocked rather than left free: the seat
 * system would drag them back on the mount's next move anyway, and a token that
 * visibly wanders off and then teleports back reads as a bug.
 */

/** The seat that holds the reins. */
export const PILOT_SEAT = 0;

export function registerSteering() {
  Hooks.on('preMoveToken', (tokenDoc, movement, options) => {
    // Never interfere with the moves we generate to carry riders.
    if (options?.[MODULE_ID]?.carried) return;

    try {
      const link = mountLink(tokenDoc);
      if (link) return handleMountedMove(tokenDoc, link, movement);
      return handleDragOntoMount(tokenDoc, movement);
    } catch (err) {
      // Never veto a movement because our own logic threw — that would strand
      // a token for reasons the user cannot see.
      log.error('steering check failed; allowing the move', err);
      return undefined;
    }
  });
}

/** A token that is already riding something. Seat 0 steers; the rest are seated. */
function handleMountedMove(tokenDoc, link, movement) {
  const mountDoc = getMount(tokenDoc);
  if (!mountDoc) return;

  if (link.seat !== PILOT_SEAT) {
    ui.notifications.info(game.i18n.localize('S187TM.Steer.Passenger'));
    return false;
  }

  // A player who cannot move the mount would have their steering silently
  // dropped by the server, so say so rather than appearing to do nothing.
  if (mountDoc.canUserModify && !mountDoc.canUserModify(game.user, 'update')) {
    ui.notifications.warn(game.i18n.localize('S187TM.Error.CannotSteer'));
    return false;
  }

  steer(mountDoc, tokenDoc, movement)
    .catch(err => log.error('failed to steer mount', err));

  // The pilot's own move is cancelled: it will be carried into its seat by the
  // mount's movement, which is what keeps the two locked together.
  return false;
}

/**
 * Move the mount along the route the pilot drew.
 *
 * The pilot's path is translated into the mount's frame by the constant offset
 * between them, so the mount traces the same shape rather than a straight line
 * to the endpoint — the same reason movement.js replays waypoints.
 *
 * No `action` is set, so the move uses the mount's own movement action and is
 * measured against the mount's speed. That is the point of piloting the mount
 * rather than the rider: riding a dragon costs dragon movement, for free.
 */
async function steer(mountDoc, riderDoc, movement) {
  const dx = mountDoc.x - riderDoc.x;
  const dy = mountDoc.y - riderDoc.y;
  const de = (mountDoc.elevation ?? 0) - (riderDoc.elevation ?? 0);

  // Only the points the pilot placed. Handing the mount the generated in-between
  // steps as real waypoints would make it walk the grid rather than the route.
  const placed = realWaypoints(movement?.pending?.waypoints);
  const requested = placed.length ? placed : [movement?.destination].filter(Boolean);
  if (!requested.length) return;

  const waypoints = requested.map(point => ({
    x: point.x + dx,
    y: point.y + dy,
    elevation: (point.elevation ?? riderDoc.elevation ?? 0) + de,
    // The offset preserves whatever alignment the pilot had, and the mount is a
    // different size, so re-snapping it to the grid would fight the pilot.
    snapped: false,
  }));

  await mountDoc.move(waypoints, {
    // The pilot's drag already resolved this against core's Token Auto-Rotate
    // setting. Re-issuing the route as an api move would otherwise default it
    // to false, and the mount would travel without ever turning to face where
    // it is going — while the pilot, carried by that move, turns correctly.
    autoRotate: movement?.autoRotate === true,
  });
}

/** An unmounted token being dragged. If it lands on a drag-target, mount it. */
function handleDragOntoMount(tokenDoc, movement) {
  if (!isRideable(tokenDoc)) return;

  const target = dragTargetUnder(tokenDoc, movement);
  if (!target) return;

  // Validate before cancelling: a refused mount must not also eat the move.
  if (validateMount(tokenDoc, target)) return;

  requestMount(tokenDoc, target)
    .catch(err => log.error('failed to mount by drag', err));

  // Cancelled because mounting will seat the token itself; letting the drag
  // land as well would put it in the wrong place for a frame.
  return false;
}

/**
 * The drag-mount token the dragged token would come to rest on, if any.
 *
 * Tested against the dragged token's centre rather than its bounds, so a large
 * token brushing a corner does not count as landing on it.
 */
function dragTargetUnder(riderDoc, movement) {
  const destination = movement?.destination;
  const scene = riderDoc.parent;
  if (!destination || !scene?.tokens) return null;

  const grid = scene.grid?.size ?? 100;
  const centreX = destination.x + ((destination.width ?? riderDoc.width ?? 1) * grid) / 2;
  const centreY = destination.y + ((destination.height ?? riderDoc.height ?? 1) * grid) / 2;

  const candidates = scene.tokens.filter(candidate => {
    if (candidate.id === riderDoc.id) return false;
    if (!acceptsDragMount(candidate)) return false;
    const width = (candidate.width ?? 1) * grid;
    const height = (candidate.height ?? 1) * grid;
    return centreX >= candidate.x && centreX < candidate.x + width
      && centreY >= candidate.y && centreY < candidate.y + height;
  });

  if (candidates.length <= 1) return candidates[0] ?? null;

  // Overlapping mounts: prefer the smallest, which is the one the user can see
  // they dropped onto rather than the map-sized thing underneath it.
  return candidates.sort((a, b) =>
    ((a.width ?? 1) * (a.height ?? 1)) - ((b.width ?? 1) * (b.height ?? 1)))[0];
}
