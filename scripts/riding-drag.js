import { MODULE_ID } from './constants.js';
import { getRiders, mountLink, steeredMount, ridesAnyOf } from './relations.js';
import { seatPosition } from './seating.js';
import { seatFor } from './movement.js';
import { log } from './logger.js';

/**
 * Dragging a rider drags the mount.
 *
 * The rider in the first seat steers, and until 0.6.0 that was done after the
 * fact: the rider was dragged like any other token, and when it was dropped its
 * move was cancelled and re-issued for the mount. Everything the player saw
 * while dragging was therefore about the rider: a ruler from the rider's seat,
 * a route planned for the rider's size, and a preview of the rider snapped to
 * a grid space half a space away from the saddle it was sitting in.
 *
 * Here the drag itself is handed to the mount before it begins. Core drags
 * whichever tokens are controlled, so the mount is controlled in the rider's
 * place for as long as the drag lasts and given back afterwards. From there it
 * is an ordinary drag of the mount: its preview, its ruler, its route, its
 * cost, snapped as a token of its size snaps, and on the drop it is the mount
 * that moves. Nothing is cancelled and re-issued.
 *
 * So that the mount does not appear to leave its riders behind, each rider
 * gets a preview of its own, kept in its seat on the mount's preview as it
 * moves. That applies to any drag of a mount, whoever started it.
 *
 * Core's Token class is extended rather than patched, at `setup`, after every
 * system and module has had its `init` to install its own class — the same
 * way Scorpious187's Token Movement does it, and the two stack in either order.
 *
 * What is left alone: a passenger's drag (refused on the drop, as before), a
 * pilot whose user may not control the mount (steered on the drop, as before),
 * and a pilot moved by a script rather than a drag (likewise).
 */

const MIXED = Symbol.for(`${MODULE_ID}.token`);

/** Previews of riders, by the preview of whatever they are riding. */
const seated = new WeakMap();

function guarded(what, fn) {
  try {
    return fn();
  } catch (err) {
    log.error(`${what} failed; the drag carries on without it`, err);
    return undefined;
  }
}

/**
 * Before a drag begins: put the mount in the rider's place.
 * @param {Token} token  The token the drag started on.
 * @returns {{taken: Token[], given: Token[]}} What to undo when the drag ends.
 */
function takeTheReins(token) {
  const reins = { taken: [], given: [] };
  const layer = token.layer;

  // The mount this token's drag moves, if it holds the reins all the way down.
  const lead = steeredMount(token.document)?.object;
  if (lead && !lead.controlled && lead.control({ releaseOthers: false })) reins.taken.push(lead);

  // Anyone whose mount is being dragged travels on it, not beside it. Left in
  // the drag they would get a ruler of their own and be moved twice.
  const dragged = new Set(layer.controlled.map(other => other.document.id));
  for (const other of layer.controlled) {
    if (ridesAnyOf(other.document, dragged)) reins.given.push(other);
  }
  for (const other of reins.given) other.release();
  return reins;
}

/** After a drag ends: the user's own selection back, the mount let go. */
function giveBackTheReins(reins) {
  if (!reins) return;
  for (const token of reins.given) {
    if (!token.destroyed && !token.controlled) token.control({ releaseOthers: false });
  }
  for (const token of reins.taken) {
    if (!token.destroyed && token.controlled) token.release();
  }
}

/**
 * Give every rider of a dragged token a preview riding that token's preview.
 * @param {Token} mount         A token being dragged.
 * @param {Token} mountPreview  Its preview.
 * @param {object} contexts     Core's drag contexts, by token id.
 */
function seatRiders(mount, mountPreview, contexts) {
  const riders = [];
  for (const riderDoc of getRiders(mount.document)) {
    const rider = riderDoc.object;
    // Not on this canvas, not shown to this user, or being dragged in its own right.
    if (!rider || rider.destroyed || !rider.visible || contexts[riderDoc.id]) continue;

    // As core makes the preview of a dragged token.
    const preview = rider.clone();
    preview._previewType = 'dragging';
    preview._onDragStart();
    preview.visible = false;
    rider.layer.preview.addChild(preview);
    preview.draw().then(drawn => { drawn.visible = true; });

    riders.push({ preview, riderDoc, seat: mountLink(riderDoc)?.seat ?? 0 });
    // Whoever rides the rider rides its preview.
    seatRiders(rider, preview, contexts);
  }
  if (riders.length) seated.set(mountPreview, { mountDoc: mount.document, riders });
}

/** A preview has moved: move the previews of its riders to their seats on it. */
function reseat(mountPreview) {
  const carrying = seated.get(mountPreview);
  if (!carrying) return;
  const frame = mountPreview.document;
  for (const { preview, riderDoc, seat } of carrying.riders) {
    if (preview.destroyed) continue;
    const at = seatPosition(frame, riderDoc, seatFor(carrying.mountDoc, seat));
    const document = preview.document;
    const moved = (document.x !== at.x) || (document.y !== at.y);
    const lifted = document.elevation !== at.elevation;
    if (!moved && !lifted) continue;
    document.x = at.x;
    document.y = at.y;
    document.elevation = at.elevation;
    preview.renderFlags.set({ refreshPosition: moved, refreshElevation: lifted });
  }
}

export function installRidingDrag() {
  const Base = CONFIG.Token?.objectClass;
  if (!Base || Base[MIXED]) return false;

  class MountingToken extends Base {
    static [MIXED] = true;

    /** @override */
    _initializeDragLeft(event) {
      const reins = guarded('taking the reins', () => takeTheReins(this));
      super._initializeDragLeft(event);
      const data = event?.interactionData;
      if (!data) return;
      data[MODULE_ID] = reins;
      guarded('seating riders on the drag preview', () => {
        const contexts = data.contexts ?? {};
        for (const { token, clonedToken } of Object.values(contexts)) seatRiders(token, clonedToken, contexts);
      });
    }

    /** @override */
    _finalizeDragLeft(event) {
      // Core clears every preview here, the riders' with the rest.
      super._finalizeDragLeft(event);
      guarded('giving back the reins', () => giveBackTheReins(event?.interactionData?.[MODULE_ID]));
    }

    /** @override */
    _refreshPosition() {
      super._refreshPosition();
      if (this.isPreview) guarded('seating riders', () => reseat(this));
    }
  }

  // Keep the base's class name, so anything that reports or keys off
  // `token.constructor.name` sees the same value with or without this module.
  Object.defineProperty(MountingToken, 'name', { value: Base.name });
  CONFIG.Token.objectClass = MountingToken;
  log.debug(`extended ${Base.name} for riding drags`);
  return true;
}
