/**
 * Seat layout.
 *
 * Seats are stored as fractions of the mount's own footprint rather than as
 * pixel or grid offsets. That keeps them correct when the mount is resized, and
 * — the reason it matters here — on gridless scaled battle scenes, where a
 * fixed grid offset would be meaningless.
 *
 * dx/dy of 0 is the mount's centre; ±0.5 is its edge.
 *
 * Offsets are in the mount's own frame, not the map's. At rotation 0 a token's
 * art faces down the screen — the convention core's auto-rotate is built on —
 * so +dy is the mount's front. seatPosition turns the offset by the mount's
 * rotation, which is what keeps a column of riders nose-to-tail along a horse
 * whichever way it is facing.
 */

/** Every layout a mount can use. `grid` is the original behaviour. */
export const SEAT_LAYOUTS = ['grid', 'center', 'corners', 'row', 'column', 'ring'];
export const DEFAULT_SEAT_LAYOUT = 'grid';

/**
 * How far from the centre riders sit, as a fraction of the mount's footprint.
 * Inset from the edge so riders sit visually on the mount rather than
 * straddling its outline.
 */
const INSET = 0.25;
const RING_RADIUS = 0.3;

/**
 * Generate seat offsets for a given number of riders.
 *
 * Note this is a whole-layout function, not a per-seat one: seat 0 of a 2-seat
 * layout is not necessarily seat 0 of a 4-seat layout. Callers must therefore
 * size the layout once from the mount's state and use it for every rider on
 * it — see `seatFor` in movement.js.
 *
 * @param {number} count   Number of seats required.
 * @param {string} layout  One of SEAT_LAYOUTS; anything else is `grid`.
 * @returns {{dx: number, dy: number}[]}
 */
export function generateSeats(count, layout = DEFAULT_SEAT_LAYOUT) {
  if (!(count > 0)) return [];
  const seats = [];
  for (let i = 0; i < count; i++) seats.push(seatIn(layout, i, count));
  return seats.map(({ dx, dy }) => ({ dx: tidy(dx), dy: tidy(dy) }));
}

function seatIn(layout, i, count) {
  switch (layout) {
    // Everyone on the middle. For a single-saddle mount, or a swarm of tiny
    // tokens that should read as one rider.
    case 'center':
      return { dx: 0, dy: 0 };

    // Side by side across the mount.
    case 'row':
      return { dx: centeredOffset(i, count), dy: 0 };

    // Nose to tail. Seat 0 — the pilot — is at the front.
    case 'column':
      return { dx: 0, dy: -centeredOffset(i, count) };

    // The four corners first, front pair then back pair, then the centre and
    // the middle of each edge: nine distinct places before any two coincide.
    case 'corners': {
      const slot = CORNER_SLOTS[i % CORNER_SLOTS.length];
      return { dx: slot[0] * INSET, dy: slot[1] * INSET };
    }

    // Evenly around the mount, starting at the front.
    case 'ring': {
      const angle = (2 * Math.PI * i) / count;
      return { dx: -RING_RADIUS * Math.sin(angle), dy: RING_RADIUS * Math.cos(angle) };
    }

    default:
      return gridSeat(i, count);
  }
}

const CORNER_SLOTS = [
  [-1, 1], [1, 1], [-1, -1], [1, -1],
  [0, 0], [0, 1], [0, -1], [-1, 0], [1, 0],
];

/**
 * The original layout: riders in rows along the mount's width, the whole block
 * centred on the mount in both axes.
 */
function gridSeat(i, count) {
  if (count === 1) return { dx: 0, dy: 0 };
  const perRow = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / perRow);
  const row = Math.floor(i / perRow);
  const col = i % perRow;
  // Seats actually in this row, so a short final row stays centred instead of
  // hugging one edge.
  const inRow = Math.min(perRow, count - row * perRow);
  return { dx: centeredOffset(col, inRow), dy: centeredOffset(row, rows) };
}

/** Spread `count` items evenly across [-INSET, INSET] around centre. */
function centeredOffset(index, count) {
  if (count <= 1) return 0;
  return (index / (count - 1) - 0.5) * (2 * INSET);
}

/** Drop floating-point noise, including -0, so layouts compare cleanly. */
function tidy(value) {
  const rounded = Math.round(value * 1e9) / 1e9;
  return rounded === 0 ? 0 : rounded;
}

/**
 * The rotation a mount's art is actually shown at. A token with Lock Rotation
 * keeps its art upright whatever its rotation field says, so its seats must not
 * turn either.
 */
export function visibleRotation(mount) {
  if (mount?.lockRotation) return 0;
  const rotation = Number(mount?.rotation);
  return Number.isFinite(rotation) ? rotation : 0;
}

/**
 * Convert a seat offset into a token position for the rider.
 *
 * Token x/y is the top-left corner, so both the mount's and the rider's own
 * footprints have to be accounted for or riders sit down-right of where they
 * should.
 *
 * @param {TokenDocument} mount  Or any frame with x, y, width, height, rotation.
 * @param {TokenDocument} rider
 * @param {{dx: number, dy: number}} seat
 * @returns {{x: number, y: number, elevation: number}}
 */
export function seatPosition(mount, rider, seat) {
  const gridSize = mount.parent?.grid?.size ?? globalThis.canvas?.grid?.size ?? 100;

  const mountW = (mount.width ?? 1) * gridSize;
  const mountH = (mount.height ?? 1) * gridSize;
  const riderW = (rider.width ?? 1) * gridSize;
  const riderH = (rider.height ?? 1) * gridSize;

  // The offset in the mount's frame, then turned with it. Foundry's rotation is
  // clockwise on screen, which with y pointing down is the ordinary rotation
  // matrix.
  let ox = (seat?.dx ?? 0) * mountW;
  let oy = (seat?.dy ?? 0) * mountH;
  const radians = (visibleRotation(mount) * Math.PI) / 180;
  if (radians) {
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    [ox, oy] = [ox * cos - oy * sin, ox * sin + oy * cos];
  }

  const centreX = mount.x + mountW / 2 + ox;
  const centreY = mount.y + mountH / 2 + oy;

  return {
    x: Math.round(centreX - riderW / 2),
    y: Math.round(centreY - riderH / 2),
    // Riders ride at the mount's elevation; without this a flying dragon leaves
    // its passengers on the ground.
    elevation: mount.elevation ?? 0,
  };
}

/**
 * The rotation an auto-rotating token has at each point of its route.
 *
 * Mirrors core: each segment turns the token to face along it, at the segment's
 * angle less 90° (plus 90° when undoing, since it travels backwards). A
 * segment that goes nowhere — a pure elevation change — keeps the previous
 * facing.
 *
 * @param {{x: number, y: number}} origin  Where the route starts.
 * @param {{x: number, y: number}[]} points
 * @param {number} initial                 The rotation before moving.
 * @param {string} [method]                The movement method; "undo" reverses.
 * @returns {number[]} One rotation per point.
 */
export function pathRotations(origin, points, initial = 0, method) {
  const offset = method === 'undo' ? 90 : -90;
  const rotations = [];
  let previous = origin;
  let rotation = initial;
  for (const point of points ?? []) {
    const dx = (point.x ?? previous.x) - previous.x;
    const dy = (point.y ?? previous.y) - previous.y;
    if (dx || dy) rotation = (Math.atan2(dy, dx) * 180) / Math.PI + offset;
    rotations.push(rotation);
    previous = point;
  }
  return rotations;
}
