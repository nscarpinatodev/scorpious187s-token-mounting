import { MODULE_ID } from './constants.js';
import { mountLink, getMount, ridesAnyOf } from './relations.js';
import { acceptsDragMount, isRideable } from './token-options.js';
import { requestMount, validateMount } from './mount.js';
import { requestedRoute, intendedPoints } from './movement.js';
import { steeredRoute } from './seating.js';
import { log } from './logger.js';

/**
 * Steering a mount by moving the pilot, and mounting by dragging.
 *
 * A pilot dragged with the pointer does not get this far any more: the drag is
 * handed to the mount before it starts (see riding-drag.js). What follows
 * still steers for every other way a pilot can be moved — a script, a user who
 * may move the mount but not select it, a version of core without the drag
 * hooks.
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

    // A rider moved in the same operation as what it rides goes nowhere on its
    // own account: the mount's move carries it. Dragging a selection that holds
    // both is the usual way to get here.
    if (ridesAnyOf(tokenDoc, options?.movement)) return false;

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
 * The pilot's path is translated into the mount's frame, so the mount traces
 * the same shape rather than a straight line to the endpoint — the same reason
 * movement.js replays waypoints. Points snapped to the grid move the mount by
 * the same count of spaces and leave it on the grid; freely placed points keep
 * the exact offset between the two (see steeredRoute in seating.js).
 *
 * No `action` is set, so the move uses the mount's own movement action and is
 * measured against the mount's speed. That is the point of piloting the mount
 * rather than the rider: riding a dragon costs dragon movement, for free.
 */
async function steer(mountDoc, riderDoc, movement) {
  const requested = requestedRoute(movement);
  if (!requested.length) return;

  // A mount on the canvas finds its own way to where the pilot was heading,
  // so it is told where that is and not how the pilot would have got there.
  const token = mountDoc.object;
  const plans = typeof token?.findMovementPath === 'function';
  const points = plans ? intendedPoints(requested) : requested;
  const targets = steeredRoute(mountDoc, riderDoc, points, mountDoc.parent?.grid ?? null);
  const waypoints = plans ? await ownRoute(token, targets) : targets;

  await mountDoc.move(waypoints, {
    // The pilot's drag already resolved this against core's Token Auto-Rotate
    // setting. Re-issuing the route as an api move would otherwise default it
    // to false, and the mount would travel without ever turning to face where
    // it is going — while the pilot, carried by that move, turns correctly.
    autoRotate: movement?.autoRotate === true,
    // Likewise the ruler: a dragged token shows its route while it travels, an
    // api move does not. The mount is travelling the route the pilot dragged,
    // so it shows it as it would have had it been dragged itself.
    showRuler: movement?.showRuler === true,
  });
}

/**
 * The mount's own route through the points it is steered to.
 *
 * The pilot's route was planned for the pilot: its size, its seat, the walls
 * its centre clears. The mount is another size and its centre is elsewhere, so
 * the same line can run it into a corner the pilot passed. `findMovementPath`
 * is where core, a system or a pathfinding module says how a token gets
 * through a list of waypoints, and it is what a drag of the mount itself would
 * have asked — so the mount is asked the same question. With nothing but core
 * installed the answer is the straight line, stopped at the first wall, which
 * is what moving it there directly would do anyway.
 *
 * Asked as a drag asks: a player's route is bent only by walls they have seen.
 *
 * @param {Token} token       The mount's token on the canvas.
 * @param {object[]} targets  Where to go, in order.
 * @returns {Promise<object[]>} Waypoints to move through; `targets` when no
 *   route comes back.
 */
async function ownRoute(token, targets) {
  try {
    const document = token.document;
    const origin = { x: document.x, y: document.y, elevation: document.elevation ?? 0 };
    const job = token.findMovementPath([origin, ...targets], {
      preview: true,
      delay: 0,
      constrainOptions: token._getDragConstrainOptions?.() ?? {},
    });
    const path = job?.result ?? await job?.promise;
    // The first point of a found path is where the token already is.
    if (Array.isArray(path) && path.length > 1) return path.slice(1);
  } catch (err) {
    log.error('mount could not plan its own route; steering it directly', err);
  }
  return targets;
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
