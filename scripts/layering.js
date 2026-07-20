/**
 * Draw order for riders.
 *
 * Foundry sorts placeables by `elevation`, then `sort`, then zIndex
 * (PlaceablesLayer#sortObjectsByElevationAndSort). Riders sit at exactly their
 * mount's elevation — deliberately, since elevation drives vision, targeting and
 * flight rules, and nudging it up to win a draw-order argument would change
 * gameplay. `sort` is the field that affects rendering and nothing else, so that
 * is the one to use.
 *
 * Seat index is added so passengers layer consistently among themselves rather
 * than flickering against each other when several share a mount.
 */

/** The sort value a rider should have to draw above its mount. */
export function desiredSort(mountSort, seat = 0) {
  const base = Number.isFinite(mountSort) ? mountSort : 0;
  return base + 1 + (Number.isFinite(seat) ? seat : 0);
}

/**
 * Bring a rider's draw order above its mount, if it is not already.
 *
 * Returns true if an update was issued. Checking first matters: `sort` rarely
 * needs to change, and an unconditional write would put a document update on
 * every single step of movement.
 */
export async function ensureLayering(riderDoc, mountDoc, seat, updateOptions = {}) {
  const target = desiredSort(mountDoc?.sort, seat);
  if (riderDoc.sort === target) return false;
  await riderDoc.update({ sort: target }, updateOptions);
  return true;
}

/**
 * Put a rider's draw order back where it was before mounting.
 * `prior` comes from the mount link, recorded at mount time.
 */
export async function restoreSort(riderDoc, prior) {
  const value = Number.isFinite(prior) ? prior : 0;
  if (riderDoc.sort === value) return;
  await riderDoc.update({ sort: value });
}
