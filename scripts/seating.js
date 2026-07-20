/**
 * Seat layout.
 *
 * Seats are stored as fractions of the mount's own footprint rather than as
 * pixel or grid offsets. That keeps them correct when the mount is resized, and
 * — the reason it matters here — on gridless scaled battle scenes, where a
 * fixed grid offset would be meaningless.
 *
 * dx/dy of 0 is the mount's centre; ±0.5 is its edge.
 */

/**
 * Generate seat offsets for a given number of riders.
 *
 * Riders are laid out in rows along the mount's width, biased toward the back
 * (positive dy) so the first seat reads as the driving position on a token
 * facing "up", which is Foundry's default orientation.
 *
 * @param {number} count  Number of seats required.
 * @returns {{dx: number, dy: number}[]}
 */
export function generateSeats(count) {
  if (count <= 0) return [];
  if (count === 1) return [{ dx: 0, dy: 0 }];

  const perRow = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / perRow);
  const seats = [];

  for (let i = 0; i < count; i++) {
    const row = Math.floor(i / perRow);
    const col = i % perRow;
    // Number of seats actually in this row, so a short final row stays centred
    // instead of hugging one edge.
    const inRow = Math.min(perRow, count - row * perRow);

    seats.push({
      dx: centeredOffset(col, inRow),
      dy: centeredOffset(row, rows),
    });
  }
  return seats;
}

/**
 * Spread `count` items evenly across [-0.25, 0.25] around centre.
 * The range is deliberately inset from the token edge so riders sit visually
 * on the mount rather than straddling its outline.
 */
function centeredOffset(index, count) {
  if (count <= 1) return 0;
  const spread = 0.5;
  return (index / (count - 1) - 0.5) * spread;
}

/**
 * Convert a seat offset into a token position for the rider.
 *
 * Token x/y is the top-left corner, so both the mount's and the rider's own
 * footprints have to be accounted for or riders sit down-right of where they
 * should.
 *
 * @param {TokenDocument} mount
 * @param {TokenDocument} rider
 * @param {{dx: number, dy: number}} seat
 * @returns {{x: number, y: number, elevation: number}}
 */
export function seatPosition(mount, rider, seat) {
  const gridSize = mount.parent?.grid?.size ?? canvas?.grid?.size ?? 100;

  const mountW = (mount.width ?? 1) * gridSize;
  const mountH = (mount.height ?? 1) * gridSize;
  const riderW = (rider.width ?? 1) * gridSize;
  const riderH = (rider.height ?? 1) * gridSize;

  const centreX = mount.x + mountW / 2 + (seat?.dx ?? 0) * mountW;
  const centreY = mount.y + mountH / 2 + (seat?.dy ?? 0) * mountH;

  return {
    x: Math.round(centreX - riderW / 2),
    y: Math.round(centreY - riderH / 2),
    // Riders ride at the mount's elevation; without this a flying dragon leaves
    // its passengers on the ground.
    elevation: mount.elevation ?? 0,
  };
}
