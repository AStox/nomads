// The centreline of the planet's streams. The bake gives each channel cell one receiver among its 8 neighbours (75 m cells), and the chain of cell centres is a staircase of right angles wherever
// the stream runs across the grid. The line drawn is instead a smooth curve through nodes that are the cell centres eased toward their neighbours along the stream, as the island's `shape`
// rounds its chains (water.ts chaikin, twice): every node moves to the weights 1/4, 1/2, 1/4 of its upstream neighbour, itself and its downstream one (the upstream neighbour is the donor
// with the biggest flow, the stream's own course through a confluence), a node with no upstream neighbour (a source) or no downstream one (the end) stays, and a centripetal Catmull-Rom
// spline (Barry and Goldman 1988; Yuksel, Schaefer and Keyser 2011 for the parametrization, whose knots t(k+1) = t(k) + |P(k+1) - P(k)|^0.5 leave no cusp or loop) runs through each
// step's two nodes with the node before and the node after for its tangents.
//
// A node's place depends on the cells within PASSES + 2 steps of it and nothing else, and a step's curve on its own two nodes and their neighbours, so the curve is a pure function of the
// stream's cells: two windows (or tiles) that both hold a stream's cells and their neighbours draw the same line, and a tributary's last step ends at the very node its river's next step starts
// from, so confluences stay joined with no seam. A node is held within MAX_MOVE of its cell's centre, so no stroke leaves its cell by more than half a cell.
const PASSES = 2; // [design] the island rounds twice
const MAX_MOVE = 0.5; // [design] cells: a node stays in its own cell
const FLAT = 0.4; // [design] m: a step is cut into pieces whose chord is within this of the curve (the stream mask's texel is 4.7 m, a first-order channel a metre wide)
const MAX_PIECES = 8;

// The curve of each channel cell's step to its receiver. `to` is the cell each drains to (-1 for none), `ok(i)` whether cell i draws a step, `flow` the donors' tie-break, (cx(i), cz(i)) the
// cell's centre and `cell` its width, all in the same units; the points come back flat as x, z pairs from the cell's node to its receiver's, both ends exactly the nodes.
export function streamCurves(n: number, to: Int32Array, ok: (i: number) => boolean, flow: Uint32Array, cx: (i: number) => number, cz: (i: number) => number, cell: number): (i: number) => number[] {
  const next = new Int32Array(n).fill(-1), prev = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) if (ok(i) && to[i] >= 0 && to[i] !== i) next[i] = to[i];
  for (let i = 0; i < n; i++) {
    const j = next[i];
    if (j >= 0 && (prev[j] < 0 || flow[i] > flow[prev[j]])) prev[j] = i;
  }
  const x0 = new Float64Array(n), z0 = new Float64Array(n);
  for (let i = 0; i < n; i++) if (next[i] >= 0 || prev[i] >= 0) { x0[i] = cx(i); z0[i] = cz(i); }
  let x = x0, z = z0;
  for (let pass = 0; pass < PASSES; pass++) {
    const xs = Float64Array.from(x), zs = Float64Array.from(z);
    for (let i = 0; i < n; i++) {
      const p = prev[i], q = next[i];
      if (p < 0 || q < 0) continue;
      let mx = 0.25 * x[p] + 0.5 * x[i] + 0.25 * x[q] - x0[i], mz = 0.25 * z[p] + 0.5 * z[i] + 0.25 * z[q] - z0[i];
      const m = Math.hypot(mx, mz), cap = MAX_MOVE * cell;
      if (m > cap) { mx *= cap / m; mz *= cap / m; }
      xs[i] = x0[i] + mx; zs[i] = z0[i] + mz;
    }
    x = xs; z = zs;
  }
  return (i: number) => {
    const j = next[i], p = prev[i], q = next[j];
    const ax = x[i], az = z[i], bx = x[j], bz = z[j];
    // the tangent neighbours: the stream's own, or the mirror of the other end where the stream starts or ends
    const px = p >= 0 ? x[p] : 2 * ax - bx, pz = p >= 0 ? z[p] : 2 * az - bz, qx = q >= 0 ? x[q] : 2 * bx - ax, qz = q >= 0 ? z[q] : 2 * bz - az;
    const knot = (ux: number, uz: number, vx: number, vz: number) => Math.max(Math.sqrt(Math.hypot(vx - ux, vz - uz)), 1e-6);
    const t1 = knot(px, pz, ax, az), t2 = t1 + knot(ax, az, bx, bz), t3 = t2 + knot(bx, bz, qx, qz), t0 = 0;
    const at = (u: number): [number, number] => {
      const t = t1 + u * (t2 - t1);
      const lerp = (aX: number, aZ: number, bX: number, bZ: number, ta: number, tb: number): [number, number] => { const w = (t - ta) / (tb - ta); return [aX + (bX - aX) * w, aZ + (bZ - aZ) * w]; };
      const a1 = lerp(px, pz, ax, az, t0, t1), a2 = lerp(ax, az, bx, bz, t1, t2), a3 = lerp(bx, bz, qx, qz, t2, t3);
      const b1 = lerp(a1[0], a1[1], a2[0], a2[1], t0, t2), b2 = lerp(a2[0], a2[1], a3[0], a3[1], t1, t3);
      return lerp(b1[0], b1[1], b2[0], b2[1], t1, t2);
    };
    // how far the curve strays from its chord at its quarter points and middle fixes the pieces it is cut into (the chord's error falls with the square of their number)
    const cl = Math.hypot(bx - ax, bz - az) || 1;
    let dev = 0;
    for (const u of [0.25, 0.5, 0.75]) { const [sx, sz] = at(u); dev = Math.max(dev, Math.abs((sx - ax) * (bz - az) - (sz - az) * (bx - ax)) / cl); }
    const pieces = Math.min(MAX_PIECES, Math.max(1, Math.ceil(Math.sqrt(dev / FLAT))));
    const out = [ax, az];
    for (let k = 1; k < pieces; k++) out.push(...at(k / pieces));
    out.push(bx, bz);
    return out;
  };
}
