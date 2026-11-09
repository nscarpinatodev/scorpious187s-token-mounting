import { MODULE_ID } from './constants.js';
import { carryAction, movementDuration } from './carry-action.js';
import { allRiders, getRiders, mountLink, isMount } from './relations.js';
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
 *
 * 3. Riders replay the mount's *path*, not just its destination.
 *
 *    This is what `updateToken` could not give us. That hook reports the fields
 *    that changed, so a move arrives as a single new x/y — the endpoint, with
 *    the route discarded. Sending a rider straight there desynchronises it two
 *    ways at once: it cuts every corner the mount rounded, and because the
 *    straight line is shorter than the real path, matching the mount's *speed*
 *    makes the rider arrive early and sit waiting.
 *
 *    On v13 that was survivable — movement updates arrived finely enough that
 *    the straight hops approximated the path. v13 and v14 batch movement
 *    differently, and on v14 the whole route collapses into one update, so the
 *    approximation collapses with it. `moveToken` hands us the actual traversed
 *    waypoints, which is the real fix rather than a version workaround: the
 *    rider now covers the same segments, the same distance, in the same time,
 *    on both versions.
 */

/**
 * Tokens this client is currently carrying. Moving a rider fires movement hooks
 * for that rider, and a rider can itself be a mount — without this guard the
 * chain would re-enter and each token would be moved once per level of depth.
 *
 * Counted rather than a plain set: on v14 `TokenDocument#move` resolves only
 * once the whole movement has finished, so a mount's next segment can start
 * carrying a rider while the previous carry is still waiting. With a set, the
 * first carry to finish would clear the token while the second was mid-flight.
 */
const inFlight = new Map();

function enterFlight(id) {
  inFlight.set(id, (inFlight.get(id) ?? 0) + 1);
}

function leaveFlight(id) {
  const remaining = (inFlight.get(id) ?? 1) - 1;
  if (remaining > 0) inFlight.set(id, remaining);
  else inFlight.delete(id);
}

/**
 * The latest carry issued for each rider, by token id. A carry that finds it
 * has been superseded stops: it must not re-check, retry or "correct" a rider
 * that a newer carry has already sent somewhere else.
 */
const carryGeneration = new Map();

/** Movement states that still hold a token's movement open. */
const UNFINISHED = new Set(['pending', 'paused']);

/**
 * Yield to a fresh task.
 *
 * `moveToken` is dispatched from inside the mount's update workflow, and core
 * holds back movement continuation until that workflow has ended. Starting a
 * rider's movement from inside it threads the rider's movement through the
 * mount's bookkeeping; starting from a fresh task keeps the two movements
 * independent, for the cost of one tick.
 */
function nextTask() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

/**
 * The waypoints someone actually placed, with Foundry's generated in-between
 * steps removed.
 *
 * A processed movement path interleaves the real waypoints with `intermediate`
 * steps along the direct line between them. Core makes the same distinction
 * itself — `pending.waypoints.filter(waypoint => !waypoint.intermediate)`.
 *
 * Replaying the intermediates as if they were real waypoints is what made a
 * carried rider crawl: each generated step became a waypoint in its own right,
 * Foundry generated further steps between *those*, and the rider traced the
 * route square by square while its mount glided over the two or three points
 * the user had actually placed. Same destination, visibly different journey.
 */
export function realWaypoints(waypoints) {
  if (!Array.isArray(waypoints)) return [];
  const real = waypoints.filter(waypoint => !waypoint.intermediate);
  // A path reported as entirely generated still has to be travelled; falling
  // back to all of it is better than deciding there is nowhere to go.
  return real.length ? real : waypoints;
}

export function registerMovementSync() {
  // Movement. `movement.passed.waypoints` is the route the mount actually
  // travelled in this operation; a multi-checkpoint drag arrives as several
  // calls, and mirroring each one keeps the rider segmented exactly as the
  // mount is — including when the mount is stopped partway by a wall.
  Hooks.on('moveToken', (tokenDoc, movement, operation) => {
    if (operation?.[MODULE_ID]?.carried) return;
    if (inFlight.has(tokenDoc.id)) return;
    if (!isMount(tokenDoc)) return;

    // If a core version ever reports a movement without a traversed path, fall
    // through to snapping riders to their seats — the behaviour before this
    // hook existed — rather than leaving them behind entirely.
    const path = realWaypoints(movement?.passed?.waypoints);
    // Riders inherit the mount's rotation decision rather than making their
    // own. They travel the same vector, so turning when it turns keeps them
    // facing the same way without having to copy its angle.
    // How long the mount's own animation takes. Handed to each rider's move so
    // core derives one speed that lands the rider when the mount lands, however
    // the route mixed actions or terrain. Measured once here, on the path the
    // mount actually travelled, and shared by every level of the chain: a
    // passenger on a knight on a dragon arrives when the dragon does.
    let duration;
    try {
      duration = movementDuration(tokenDoc, movement);
    } catch (err) {
      log.error('failed to measure mount animation; riders use their default pace', err);
    }

    carryRiders(tokenDoc, path.length ? path : null, movement?.autoRotate === true, { duration })
      .catch(err => log.error('failed to carry riders', err));
  });

  // Draw order is not movement, so it never reaches moveToken. A mount's `sort`
  // changing still has to pull its riders back above it, or they render
  // underneath. Position is deliberately not handled here — see above.
  Hooks.on('updateToken', (tokenDoc, changed, options) => {
    if (options?.[MODULE_ID]?.carried) return;
    if (inFlight.has(tokenDoc.id)) return;
    if (!('sort' in changed)) return;
    if (!isMount(tokenDoc)) return;

    carryRiders(tokenDoc).catch(err => log.error('failed to re-layer riders', err));
  });
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

/**
 * Treat one point along a mount's path as if it were the mount's own position,
 * so seatPosition can be reused unchanged.
 *
 * Real waypoints carry their own footprint (a token can resize mid-move); the
 * synthetic points we derive for chained riders carry only a position, so the
 * rest falls back to the document.
 */
function frameAt(mountDoc, point) {
  return {
    x: point.x ?? mountDoc.x,
    y: point.y ?? mountDoc.y,
    elevation: point.elevation ?? mountDoc.elevation,
    width: point.width ?? mountDoc.width,
    height: point.height ?? mountDoc.height,
    parent: mountDoc.parent,
  };
}

/**
 * @param {TokenDocument} mountDoc  The token that moved.
 * @param {object[]|null} mountPath The route it travelled, or null to snap
 *                                  riders to their seats without animating.
 * @param {boolean} autoRotate      Whether the mount's movement turned it to
 *                                  face its direction of travel.
 */
async function carryRiders(mountDoc, mountPath = null, autoRotate = false, { force = false, duration } = {}) {
  // Resolve the whole chain from this mount down, so a passenger on a rider
  // moves too. allRiders is cycle-guarded, and returns nearest-first — which
  // matters below, because each rider's path is derived from its parent's.
  const riders = allRiders(mountDoc);
  if (!riders.length) return;

  // The route each carried token takes, keyed by token id. Seeded with the
  // mount's own route so riders one level down can be offset from it; each
  // rider's resulting route then seeds the level below, so a passenger on a
  // knight on a dragon follows the knight, which follows the dragon.
  const paths = new Map([[mountDoc.id, mountPath]]);
  // The riders this client is elected to move, with their resolved routes.
  const carries = [];

  for (const rider of riders) {
    // The seat is relative to whatever this rider is directly riding, which is
    // not necessarily the token that started the chain.
    const parent = rider.parent?.tokens?.get(mountLink(rider)?.tokenId);
    if (!parent) continue;

    const seatIndex = mountLink(rider)?.seat ?? 0;
    const seat = seatFor(parent, seatIndex);
    const parentPath = paths.get(parent.id);

    // Same seat offset applied at every point of the parent's route, so the
    // rider traces the parent's shape rather than a chord across it.
    const path = parentPath?.length
      ? parentPath.map(point => seatPosition(frameAt(parent, point), rider, seat))
      : [seatPosition(parent, rider, seat)];

    // Recorded even when this client is not the one moving the rider, so the
    // chain below it still resolves against the right route.
    paths.set(rider.id, path);
    // The arbitration below exists because `moveToken` fires on every client,
    // so exactly one has to be elected to issue the update. A caller that is
    // already running on a single client — seating riders straight after a
    // mount, which only ever happens GM-side — must skip it, or the elected
    // client (the rider's owner) never hears about the move and the rider sits
    // unmoved until the mount's next step.
    if (!force && !shouldIMove(rider)) continue;

    carries.push({ rider, parent, seatIndex, path });
  }
  if (!carries.length) return;

  for (const carry of carries) {
    const { rider, path } = carry;
    // A multi-point path is always worth issuing: the rider has ground to cover
    // even when it happens to end where it started, as on a loop.
    carry.moves = path.length > 1 || !samePosition(rider, path[path.length - 1]);
    // Claimed before the first await, so a carry overtaken by a newer one for
    // the same rider (the mount's next checkpoint, say) knows to stand down.
    // Only by carries that will move it: a re-layer must not cancel the retry of
    // a movement still in flight.
    if (carry.moves) {
      carry.generation = (carryGeneration.get(rider.id) ?? 0) + 1;
      carryGeneration.set(rider.id, carry.generation);
    }
    enterFlight(rider.id);
  }

  try {
    await nextTask();

    // Draw order first, so each rider is already above its mount by the time it
    // visibly arrives rather than surfacing a frame later. One at a time and
    // nearest-first: a passenger's sort is derived from its own rider's, which
    // may be changing in the step before it.
    for (const { rider, parent, seatIndex } of carries) {
      try {
        await ensureLayering(rider, parent, seatIndex, { [MODULE_ID]: { carried: true } });
      } catch (err) {
        log.error(`failed to layer rider "${rider.name}"`, err);
      }
    }

    // Movement all at once. Every route is already resolved above, so nothing
    // here depends on another rider having arrived — and on v14, where `move`
    // resolves only when the movement is complete, awaiting each in turn made a
    // second passenger wait for the first to finish its whole journey.
    await Promise.all(carries
      .filter(carry => carry.moves)
      .map(carry => carryOne(carry, autoRotate, duration)));
  } finally {
    for (const { rider } of carries) leaveFlight(rider.id);
  }
}

/** Move one rider along its resolved route, unless a newer carry has taken over. */
async function carryOne({ rider, path, generation }, autoRotate, duration) {
  const isCurrent = () => carryGeneration.get(rider.id) === generation;
  if (!isCurrent()) return;

  try {
    await moveRider(rider, path, autoRotate, duration, isCurrent);
  } catch (err) {
    log.error(`failed to carry rider "${rider.name}"`, err);
  }
}

function samePosition(riderDoc, target) {
  return riderDoc.x === target.x
    && riderDoc.y === target.y
    && (riderDoc.elevation ?? 0) === (target.elevation ?? 0);
}

/**
 * The seat offset for one rider, regenerated from the mount's current state.
 *
 * Only *direct* riders count. A passenger riding one of our riders sits on that
 * rider's footprint, not ours — counting the whole chain here would size the
 * layout for tokens that are not on us, and push a lone rider off centre.
 *
 * The grid is sized from the highest seat index still in use rather than from
 * the rider count, because indices are stable and outlive the riders between
 * them. Sizing by count would give a rider in seat 0 a two-seat grid while a
 * rider in seat 3 got a four-seat grid, and the two would overlap.
 */
function seatFor(mountDoc, seatIndex) {
  const riders = getRiders(mountDoc);
  const highest = riders.reduce((max, r) => Math.max(max, mountLink(r)?.seat ?? 0), 0);
  const seats = generateSeats(Math.max(riders.length, highest + 1, seatIndex + 1));
  return seats[seatIndex] ?? { dx: 0, dy: 0 };
}

async function moveRider(riderDoc, path, autoRotate = false, duration, isCurrent = () => true) {
  const options = {
    [MODULE_ID]: { carried: true },
    // The mount has already paid for this movement and already resolved walls;
    // a passenger must not be re-charged or re-blocked.
    constrainOptions: { ignoreWalls: true, ignoreCost: true },
    // Must be passed explicitly. Core resolves auto-rotation from the *method*
    // of movement: a drag reads core's Token Auto-Rotate setting, but an api
    // move — which this is — defaults to false. Left off, a rider slides
    // sideways down the road while the mount turns to face along it.
    autoRotate,
  };

  // Present only when the mount's route was measured, so a snap to a seat never
  // carries one. Not gated on the rider's point count: a plain drag from A to B
  // is a single waypoint, and it is the move that most needs matching. Core's
  // `_configureAnimationMovementSpeed` spreads the duration across the rider's
  // waypoints as one movement speed, stored on the operation so every client
  // animates the rider identically. Zero means the mount arrived instantly, and
  // core makes the rider do the same.
  if (Number.isFinite(duration) && duration >= 0) {
    options.animation = { duration };
  }

  // The waypoint API carries the action per movement rather than requiring the
  // token's persistent movementAction to be mutated and restored.
  const destination = path[path.length - 1];
  const action = carryAction();
  if (typeof riderDoc.move === 'function' && action) {
    // `explicit` and `checkpoint` are left off deliberately: the rider is not
    // steering, so its route needs no user-placed waypoints and no points at
    // which movement could be independently stopped or resumed. The mount
    // already owns those decisions, and a checkpoint here would split the
    // rider's movement into operations the mount never made.
    const waypoints = path.map(point => ({ ...point, action, snapped: false }));

    // A movement left open with nothing animating it is stale, not in progress,
    // and v14 will not start a new movement on top of it. Clear it first.
    if (hasStaleMovement(riderDoc)) stopUnfinishedMovement(riderDoc);

    let completed = await riderDoc.move(waypoints, options);
    if (!isCurrent() || arrived(completed, riderDoc, destination)) return completed;

    // Refused. The usual cause is the rider's previous movement still being
    // open — legitimately animating, since the rider starts a beat after its
    // mount and so lands a beat after it too. Close it and try once more.
    log.debug(`carried move of "${riderDoc.name}" was refused; closing its open movement and retrying`);
    stopUnfinishedMovement(riderDoc);
    await nextTask();
    if (!isCurrent()) return completed;

    completed = await riderDoc.move(waypoints, options);
    if (!isCurrent() || arrived(completed, riderDoc, destination)) return completed;

    // Last resort, so a refusal costs the animation rather than the rider.
    log.warn(`carried move of "${riderDoc.name}" was refused twice; placing it on its seat directly`);
    return riderDoc.update(destination, { ...options, animate: false });
  }

  // Defensive fallback: if the movement API is absent or renamed, a plain
  // update still puts the rider in the right place, just without displace
  // semantics. Better than the rider silently staying behind.
  log.warn('TokenDocument#move unavailable; falling back to a direct update');
  return riderDoc.update(destination, { ...options, animate: false });
}

/**
 * Did a carried move do its job?
 *
 * `TokenDocument#move` resolves false when the movement was stopped or
 * prevented. Stopped *after* arriving is still a rider in its seat, so position
 * decides, not the flag alone. v13 builds that predate the boolean result
 * resolve with something other than false, which counts as success.
 */
function arrived(completed, riderDoc, destination) {
  return completed !== false || samePosition(riderDoc, destination);
}

/**
 * Whether the rider has a movement still open that nothing is driving: left
 * pending or paused, but with no animation playing to finish it.
 *
 * A token that is not drawn on this client's canvas cannot be checked for an
 * animation, so an open movement on one counts as stale — carrying it is the
 * only thing this client does with the rider, and the carry is what is waiting.
 */
function hasStaleMovement(riderDoc) {
  if (!UNFINISHED.has(riderDoc.movement?.state)) return false;
  const placeable = riderDoc.rendered ? riderDoc.object : null;
  return !placeable?.movementAnimationPromise;
}

/**
 * Stop the rider's open movement, if it has one this client is allowed to stop.
 * Core only lets the user who started a movement stop it, which for a carried
 * rider is the client carrying it — this one. Never throws: failing to close a
 * movement is handled by the retry that follows, not by abandoning the carry.
 */
function stopUnfinishedMovement(riderDoc) {
  if (!UNFINISHED.has(riderDoc.movement?.state)) return false;
  if (typeof riderDoc.stopMovement !== 'function') return false;
  try {
    return riderDoc.stopMovement() === true;
  } catch (err) {
    log.debug(`could not stop the open movement of "${riderDoc.name}"`, err);
    return false;
  }
}

/**
 * Snap every rider to its seat immediately, without waiting for a move.
 *
 * Forced: this is called from a single client that has already decided to act
 * (the GM, right after a mount is established), rather than from a hook that
 * fires everywhere. Leaving it to the usual election would hand the job to the
 * rider's owner, who is not running this code.
 */
export async function resnap(mountDoc) {
  await carryRiders(mountDoc, null, false, { force: true });
}
