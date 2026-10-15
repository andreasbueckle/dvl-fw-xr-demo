import { Ray } from '@babylonjs/core';

/**
 * Uniform grid over the chart's [-0.5, 0.5]³ cube, so a ray only has to be tested against the points
 * in the cells it passes through rather than all ~130k. Each point is registered in every cell its
 * pick sphere overlaps, so walking the ray's cells finds every candidate.
 */
export class PointGrid {
  private readonly cellStart: Int32Array;
  private readonly cellPoints: Int32Array;

  /** `positions` holds x, y, z per point in chart-local coordinates. */
  constructor(
    private readonly positions: Float32Array,
    private readonly radius: number,
    private readonly res = 64,
  ) {
    const count = positions.length / 3;
    const counts = new Int32Array(res ** 3 + 1);
    for (let i = 0; i < count; i++) this.forEachCell(i, (c) => counts[c + 1]++);
    for (let c = 1; c < counts.length; c++) counts[c] += counts[c - 1];
    this.cellStart = counts;
    this.cellPoints = new Int32Array(counts[counts.length - 1]);
    const fill = counts.slice(0, -1);
    for (let i = 0; i < count; i++) this.forEachCell(i, (c) => (this.cellPoints[fill[c]++] = i));
  }

  /**
   * Index of the first point whose pick sphere the ray (in chart-local space) hits, or -1.
   * `radiusOf` gives each point's pick radius; 0 skips the point, and anything above the grid's
   * radius is capped to it, since points are only registered in cells within that radius.
   */
  pick(ray: Ray, radiusOf: (i: number) => number = () => this.radius): number {
    const { origin: o, direction } = ray;
    const d = direction.normalizeToNew();
    const bound = 0.5 + this.radius;

    // Clip the ray to the (padded) chart cube.
    let tMin = 0;
    let tMax = Infinity;
    for (const [oa, da] of [[o.x, d.x], [o.y, d.y], [o.z, d.z]]) {
      if (Math.abs(da) < 1e-12) {
        if (oa < -bound || oa > bound) return -1;
        continue;
      }
      let t0 = (-bound - oa) / da;
      let t1 = (bound - oa) / da;
      if (t0 > t1) [t0, t1] = [t1, t0];
      tMin = Math.max(tMin, t0);
      tMax = Math.min(tMax, t1);
      if (tMin > tMax) return -1;
    }

    // March in half-cell steps; a straight line never re-enters a cell, so skipping repeats is enough.
    const cellSize = 1 / this.res;
    const step = cellSize / 2;
    let lastCell = -1;
    let best = -1;
    let bestT = Infinity;
    for (let t = tMin; t <= tMax + step; t += step) {
      // Points in later cells can't be closer than one cell beyond the best hit so far.
      if (t > bestT + 2 * cellSize) break;
      const cell = this.cellOf(o.x + d.x * t, o.y + d.y * t, o.z + d.z * t);
      if (cell === lastCell) continue;
      lastCell = cell;
      for (let k = this.cellStart[cell]; k < this.cellStart[cell + 1]; k++) {
        const i = this.cellPoints[k];
        const px = this.positions[i * 3] - o.x;
        const py = this.positions[i * 3 + 1] - o.y;
        const pz = this.positions[i * 3 + 2] - o.z;
        const tp = px * d.x + py * d.y + pz * d.z;
        if (tp < 0 || tp >= bestT) continue;
        const r = Math.min(radiusOf(i), this.radius);
        if (r > 0 && px * px + py * py + pz * pz - tp * tp <= r * r) {
          best = i;
          bestT = tp;
        }
      }
    }
    return best;
  }

  private axisCell(v: number): number {
    return Math.min(this.res - 1, Math.max(0, Math.floor((v + 0.5) * this.res)));
  }

  private cellOf(x: number, y: number, z: number): number {
    return (this.axisCell(x) * this.res + this.axisCell(y)) * this.res + this.axisCell(z);
  }

  private forEachCell(i: number, cb: (cell: number) => void): void {
    const p = this.positions;
    const r = this.radius;
    const [x, y, z] = [p[i * 3], p[i * 3 + 1], p[i * 3 + 2]];
    for (let cx = this.axisCell(x - r); cx <= this.axisCell(x + r); cx++)
      for (let cy = this.axisCell(y - r); cy <= this.axisCell(y + r); cy++)
        for (let cz = this.axisCell(z - r); cz <= this.axisCell(z + r); cz++) cb((cx * this.res + cy) * this.res + cz);
  }
}
