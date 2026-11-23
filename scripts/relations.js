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
 * Are two tokens part of the same mount: one riding the other, at any depth,
 * or both riding the same thing? They travel as one, so neither is in the
 * other's way.
 */
export function ridesTogether(tokenDoc, otherDoc) {
  if (!tokenDoc || !otherDoc || tokenDoc.id === otherDoc.id) return false;
  if (tokenDoc.parent?.id !== otherDoc.parent?.id) return false;
  // Two tokens that ride nothing are their own roots, and those differ.
  return rootMount(tokenDoc)?.id === rootMount(otherDoc)?.id;
}

/**
 * The mount a drag of this token moves: the one it rides if it holds the
 * reins, and on down while each mount holds the reins of the next. A page
 * steering a knight who steers a dragon moves the dragon.
 *
 * @param {TokenDocument} tokenDoc
 * @param {number} [pilotSeat=0]  The seat that steers.
 * @returns {TokenDocument|null} Null when it rides nothing, or when anyone on
 *   the way down is a passenger: a passenger cannot move what it sits on.
 */
export function steeredMount(tokenDoc, pilotSeat = 0) {
  const seen = new Set([tokenDoc?.id]);
  let current = tokenDoc;
  let lead = null;
  for (;;) {
    const link = mountLink(current);
    if (!link) return lead;
    if ((link.seat ?? 0) !== pilotSeat) return null;
    const mount = getMount(current);
    if (!mount || seen.has(mount.id)) return lead;
    seen.add(mount.id);
    lead = mount;
    current = mount;
  }
}

/**
 * Is this token riding, at any depth, one of the tokens with these ids?
 * @param {TokenDocument} tokenDoc
 * @param {Set<string>|object} ids  A set of token ids, or an object keyed by them.
 */
export function ridesAnyOf(tokenDoc, ids) {
  const has = id => (ids instanceof Set ? ids.has(id) : Boolean(ids) && Object.hasOwn(ids, id));
  const seen = new Set([tokenDoc?.id]);
  for (let mount = getMount(tokenDoc); mount && !seen.has(mount.id); mount = getMount(mount)) {
    if (has(mount.id)) return true;
    seen.add(mount.id);
  }
  return false;
}

/** @returns {number|null} The seat this token holds on its mount, or null if it rides nothing. */
export function getSeat(riderDoc) {
  const link = mountLink(riderDoc);
  return link ? (link.seat ?? 0) : null;
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
