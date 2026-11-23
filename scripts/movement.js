import { MODULE_ID } from './constants.js';
import { carryAction, movementDuration } from './carry-action.js';
import { allRiders, getRiders, mountLink, isMount } from './relations.js';
import { seatPosition, generateSeats, pathRotations, facingOf } from './seating.js';
import { seatLayoutOf, FLAG_SEAT_LAYOUT } from './token-options.js';
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
 */
const inFlight = new Set();

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

/**
 * The route a movement is asking for, before any of it has happened: the
 * waypoints someone placed, in order.
 *
 * `preMoveToken` is where this is read, and there the route is split in two.
 * `passed` is the stretch about to be travelled — on v14 that is the whole
 * route, or as far as its first checkpoint — and `pending` is whatever lies
 * beyond that checkpoint. Reading `pending` alone, as steering used to, finds
 * nothing for an ordinary drag: the mount was then sent straight to the
 * destination, losing every turn the pilot's route took round a wall, and the
 * destination on its own does not say whether it was snapped to the grid.
 *
 * @returns {object[]} Empty only when the movement names nowhere to go.
 */
export function requestedRoute(movement) {
  const route = [...(movement?.passed?.waypoints ?? []), ...(movement?.pending?.waypoints ?? [])];
  const placed = realWaypoints(route);
  return placed.length ? placed : [movement?.destination].filter(Boolean);
}

/**
 * The points of a route that say where its maker wanted to go: the waypoints
 * they set and the place they let go, without the turns a pathfinder put in
 * between to get there.
 *
 * A pathfinder's turns suit the token they were found for. Handed to a mount
 * twice the size they can clip a corner the pilot cleared, so when the mount
 * can find its own way (see steering.js) it is given only these.
 *
 * @returns {object[]} All of `route` when nothing in it is marked either way.
 */
export function intendedPoints(route) {
  const intended = (route ?? []).filter(point => point.explicit || point.checkpoint);
  return intended.length ? intended : (route ?? []);
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

    carryRiders(tokenDoc, path.length ? path : null, movement?.autoRotate === true, {
      duration,
      // Where the route started and how it was made, so an auto-rotating mount's
      // facing can be worked out at every point and the seats turned with it.
      origin: movement?.origin,
      method: movement?.method,
    })
      .catch(err => log.error('failed to carry riders', err));
  });

  // Changes that are not movement never reach moveToken but still move seats:
  // `sort` has to pull riders back above the mount, and turning the mount by
  // hand, toggling Lock Rotation or choosing a different layout all put the
  // seats somewhere new. Rotation that arrives *with* a move is auto-rotation,
  // and moveToken already handles it along the route — reseating here as well
  // would carry the riders twice.
  Hooks.on('updateToken', (tokenDoc, changed, options) => {
    if (options?.[MODULE_ID]?.carried) return;
    if (inFlight.has(tokenDoc.id)) return;

    const moved = ['x', 'y', 'elevation', 'width', 'height'].some(key => key in changed);
    const reseat = 'sort' in changed
      || ('rotation' in changed && !moved)
      || 'lockRotation' in changed
      || foundry.utils.hasProperty(changed, `flags.${MODULE_ID}.${FLAG_SEAT_LAYOUT}`);
    if (!reseat) return;
    if (!isMount(tokenDoc)) return;

    // A mount turned by hand turns its riders with it, not just their seats.
    // The facing comes from the change itself: the document's own rotation is
    // still the old one at this point, and animates towards the new (see atRest).
    const turned = 'rotation' in changed && !moved;
    carryRiders(tokenDoc, null, false, turned ? { facing: changed.rotation } : {})
      .catch(err => log.error('failed to reseat riders', err));
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
 * A token as it will be once its animations have finished.
 *
 * On v14 a token document's position and rotation are animated in place: for
 * as long as the token is turning on screen, `document.rotation` is wherever
 * the turn has got to. Its source holds where it is going. Seats worked out
 * from the animated values land wherever the mount happened to be facing at
 * that instant — one rider of a horse turned by hand was seated for the old
 * facing and the next for the new.
 */
function atRest(tokenDoc) {
  const source = tokenDoc._source ?? tokenDoc;
  return {
    x: source.x ?? tokenDoc.x,
    y: source.y ?? tokenDoc.y,
    elevation: source.elevation ?? tokenDoc.elevation,
    width: source.width ?? tokenDoc.width,
    height: source.height ?? tokenDoc.height,
    rotation: source.rotation ?? tokenDoc.rotation,
    lockRotation: source.lockRotation ?? tokenDoc.lockRotation,
    parent: tokenDoc.parent,
  };
}

/**
 * Treat one point along a mount's path as if it were the mount's own position,
 * so seatPosition can be reused unchanged.
 *
 * Real waypoints carry their own footprint (a token can resize mid-move); the
 * synthetic points we derive for chained riders carry only a position, so the
 * rest falls back to the document.
 */
function frameAt(mountDoc, point, rotation) {
  return {
    x: point.x ?? mountDoc.x,
    y: point.y ?? mountDoc.y,
    elevation: point.elevation ?? mountDoc.elevation,
    width: point.width ?? mountDoc.width,
    height: point.height ?? mountDoc.height,
    // Waypoints carry no facing, so an auto-rotating route supplies one per
    // point; otherwise the token keeps the rotation it has.
    rotation: rotation ?? mountDoc.rotation,
    lockRotation: mountDoc.lockRotation,
    parent: mountDoc.parent,
  };
}

/**
 * @param {TokenDocument} mountDoc  The token that moved.
 * @param {object[]|null} mountPath The route it travelled, or null to snap
 *                                  riders to their seats without animating.
 * @param {boolean} autoRotate      Whether the mount's movement turned it to
 *                                  face its direction of travel.
 * @param {object} [options]
 * @param {number} [options.facing] The rotation riders should end at, when the
 *                                  mount was turned without being moved.
 */
async function carryRiders(mountDoc, mountPath = null, autoRotate = false, {
  force = false, duration, origin, method, facing,
} = {}) {
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

  // The facing at each point of the route, when the mount turns as it goes.
  // Seats turn with the mount, so a rider rounding a corner swings round with
  // it rather than staying where the seat was before the turn. Shared by every
  // level of the chain: carried riders turn with the same decision as the
  // mount, so they face the same way at the same point.
  const rotations = autoRotate && mountPath?.length
    ? pathRotations(origin ?? mountPath[0], mountPath, mountDoc.rotation, method)
    : null;

  // The way riders face when they arrive: the way the mount does.
  //
  // A rider used to work its facing out for itself, from its own route. That
  // was the same answer as the mount's for as long as seats did not turn. Now
  // that they do, a rider off the mount's middle swings round as the mount
  // turns, its route is no longer parallel to the mount's, and it arrived
  // facing a few degrees off: two riders either side of a horse that had
  // turned to face west ended at 96 and 85 degrees against the horse's 90.
  const arriveFacing = facingOf(rotations ? rotations.at(-1) : facing);

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
      ? parentPath.map((point, i) => seatPosition(frameAt(parent, point, rotations?.[i]), rider, seat))
      : [seatPosition(atRest(parent), rider, seat)];

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

    inFlight.add(rider.id);
    try {
      // Draw order first, so the rider is already above its mount by the time
      // it visibly arrives rather than surfacing a frame later.
      await ensureLayering(rider, parent, seatIndex, { [MODULE_ID]: { carried: true } });
      const destination = path[path.length - 1];
      // A multi-point path is always worth issuing: the rider has ground to
      // cover even when it happens to end where it started, as on a loop.
      if (path.length > 1 || !samePosition(rider, destination)) {
        await moveRider(rider, path, autoRotate, duration, arriveFacing);
      } else if (arriveFacing !== undefined && facingOf(atRest(rider).rotation) !== arriveFacing) {
        // In its seat already, as on the mount's middle: it only has to turn.
        await rider.update({ rotation: arriveFacing }, { [MODULE_ID]: { carried: true } });
      }
    } catch (err) {
      log.error(`failed to carry rider "${rider.name}"`, err);
    } finally {
      inFlight.delete(rider.id);
    }
  }
}

function samePosition(riderDoc, target) {
  const rider = atRest(riderDoc);
  return rider.x === target.x
    && rider.y === target.y
    && (rider.elevation ?? 0) === (target.elevation ?? 0);
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
export function seatFor(mountDoc, seatIndex) {
  const riders = getRiders(mountDoc);
  const highest = riders.reduce((max, r) => Math.max(max, mountLink(r)?.seat ?? 0), 0);
  const seats = generateSeats(Math.max(riders.length, highest + 1, seatIndex + 1), seatLayoutOf(mountDoc));
  return seats[seatIndex] ?? { dx: 0, dy: 0 };
}

async function moveRider(riderDoc, path, autoRotate = false, duration, facing) {
  const options = {
    [MODULE_ID]: { carried: true },
    // The mount has already paid for this movement and already resolved walls;
    // a passenger must not be re-charged or re-blocked. `ignoreTokens` is
    // dnd5e's: there a creature can be stopped by another creature's space,
    // and a rider's seat is by definition inside its mount's.
    constrainOptions: { ignoreWalls: true, ignoreCost: true, ignoreTokens: true },
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
  const action = carryAction();

  // With a facing to arrive at, the move is issued as the update that
  // `TokenDocument#move` would make, with the rotation added to it. Core only
  // works a facing out from the route when the update does not already name
  // one, and its animation turns the token along the way and then to whatever
  // the document says — so the rider still turns as it travels, and ends
  // exactly where its mount does.
  if (typeof riderDoc.move === 'function' && action && facing !== undefined
    && facingOf(atRest(riderDoc).rotation) !== facing) {
    const { constrainOptions, autoRotate: turns, ...rest } = options;
    try {
      return await riderDoc.update({ rotation: facing }, {
        ...rest,
        movement: {
          [riderDoc.id]: {
            waypoints: path.map(point => ({ ...point, action, snapped: false })),
            method: 'api',
            autoRotate: turns,
            constrainOptions,
          },
        },
      });
    } catch (err) {
      log.error('could not turn a rider with its move; moving it and leaving its facing', err);
    }
  }

  if (typeof riderDoc.move === 'function' && action) {
    return riderDoc.move(
      // `explicit` and `checkpoint` are left off deliberately: the rider is not
      // steering, so its route needs no user-placed waypoints and no points at
      // which movement could be independently stopped or resumed. The mount
      // already owns those decisions, and a checkpoint here would split the
      // rider's movement into operations the mount never made.
      path.map(point => ({ ...point, action, snapped: false })),
      options,
    );
  }

  // Defensive fallback: if the movement API is absent or renamed, a plain
  // update still puts the rider in the right place, just without displace
  // semantics. Better than the rider silently staying behind.
  log.warn('TokenDocument#move unavailable; falling back to a direct update');
  return riderDoc.update(path[path.length - 1], { ...options, animate: false });
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

/**
 * Re-seat the riders of every mount in the world, after the world's default
 * layout changes. Only top-level mounts are walked: carrying one carries its
 * whole chain, so starting from a rider as well would seat its passengers
 * twice. Not forced — this runs on every client, and the usual election picks
 * the one that moves each rider.
 */
export function reseatAll() {
  for (const scene of game.scenes ?? []) {
    for (const tokenDoc of scene.tokens ?? []) {
      if (!isMount(tokenDoc) || mountLink(tokenDoc)) continue;
      carryRiders(tokenDoc).catch(err => log.error('failed to reseat riders', err));
    }
  }
}
