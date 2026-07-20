import { MODULE_ID, FLAG_MOUNT } from './constants.js';

/**
 * Reading the rider/mount graph. All lookups derive from the rider's flag, so
 * there is no second list to fall out of sync.
 */

/** @returns {{tokenId: string, seat: number}|null} */
export function mountLink(riderDoc) {
  return riderDoc?.getFlag(MODULE_ID, FLAG_MOUNT) ?? null;
}

/** @returns {TokenDocument|null} The mount this token is riding, if any. */
export function getMount(riderDoc) {
  const link = mountLink(riderDoc);
  if (!link?.tokenId) return null;
  return riderDoc.parent?.tokens?.get(link.tokenId) ?? null;
}

/** @returns {TokenDocument[]} Tokens riding this mount, ordered by seat. */
export function getRiders(mountDoc) {
  if (!mountDoc?.parent) return [];
  return mountDoc.parent.tokens
    .filter(t => mountLink(t)?.tokenId === mountDoc.id)
    .sort((a, b) => (mountLink(a)?.seat ?? 0) - (mountLink(b)?.seat ?? 0));
}

export function isMounted(tokenDoc) {
  return Boolean(mountLink(tokenDoc));
}

export function isMount(tokenDoc) {
  return getRiders(tokenDoc).length > 0;
}

/**
 * Walk up the mount chain to the token that actually carries everything.
 *
 * A rider can itself be a mount (a knight on a dragon carrying a passenger), so
 * movement has to resolve to the root before syncing. The visited set guards
 * against a cycle — which should be impossible, but a corrupted flag that made
 * two tokens ride each other would otherwise hang the client.
 */
export function rootMount(tokenDoc, visited = new Set()) {
  if (!tokenDoc || visited.has(tokenDoc.id)) return tokenDoc;
  visited.add(tokenDoc.id);
  const parent = getMount(tokenDoc);
  return parent ? rootMount(parent, visited) : tokenDoc;
}

/**
 * Every token carried by this one, at any depth, nearest first.
 * Cycle-guarded for the same reason as rootMount.
 */
export function allRiders(mountDoc, visited = new Set()) {
  const out = [];
  if (!mountDoc || visited.has(mountDoc.id)) return out;
  visited.add(mountDoc.id);

  for (const rider of getRiders(mountDoc)) {
    if (visited.has(rider.id)) continue;
    out.push(rider);
    out.push(...allRiders(rider, visited));
  }
  return out;
}

/** Would mounting `rider` onto `mount` create a loop? */
export function wouldCycle(riderDoc, mountDoc) {
  if (!riderDoc || !mountDoc) return false;
  if (riderDoc.id === mountDoc.id) return true;
  return allRiders(riderDoc).some(t => t.id === mountDoc.id);
}

/** Lowest unused seat index on this mount. */
export function nextFreeSeat(mountDoc) {
  const taken = new Set(getRiders(mountDoc).map(r => mountLink(r)?.seat ?? 0));
  let seat = 0;
  while (taken.has(seat)) seat++;
  return seat;
}
