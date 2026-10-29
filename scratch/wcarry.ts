// Windowed tier-0 to tier-5 carry of a variant, interior windows only (edge cells replicate; the halo is thrown away).
import { child4 } from "../src/gpu/globe/regional";
import { unpackRecord } from "../src/gpu/globe/window";
import { readFileSync, readdirSync } from "node:fs";
import { g0, at } from "./places";
const H = process.env.HOME + "/.cache/";
export const NEWKEY = readdirSync(H + "nomads-scratch/t5/bake/small/store/")[0];
export const storeDir = H + "nomads-scratch/t5/bake/small/store/" + NEWKEY + "/";
let chain: Record<string, any> | null = null;
export const chainArrays = () => (chain ??= unpackRecord(new Uint8Array(readFileSync(storeDir + "chain.bin"))).arrays);

// tier-0 window (1/256 m ints) of side S around (face, cx, cy): heights = chain heights less the sea level the ice stage gave (-0.0345 m)
export function window0(name: string, S: number, kind: "fine" | "int" = "fine"): { h: Int32Array; face: number; x0: number; y0: number; S: number } {
  const p = at(name, g0), a = chainArrays()[kind === "fine" ? "height" : "heightM"] as Float32Array, fn = g0.fn;
  const x0 = Math.max(0, Math.min(fn - S, p.X - (S >> 1))), y0 = Math.max(0, Math.min(fn - S, p.Y - (S >> 1)));
  const h = new Int32Array(S * S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) h[y * S + x] = Math.round((a[(p.face * fn + y0 + y) * fn + x0 + x] + 0.0345) * 256);
  return { h, face: p.face, x0, y0, S };
}

const limitChildren = (v: number[], s4: number, lo: number, hi: number) => restore(v, s4, [lo, lo, lo, lo], [hi, hi, hi, hi]);
export type Variant = (parent: Float64Array, S: number) => Int32Array; // children, side 2S

const clampIx = (v: number, S: number) => (v < 0 ? 0 : v >= S ? S - 1 : v);
function children(src: Float64Array, S: number, out: Float64Array) {
  const q = new Float64Array(4), fn = 2 * S;
  for (let Y = 0; Y < S; Y++) for (let X = 0; X < S; X++) {
    const g = (dx: number, dy: number) => src[clampIx(Y + dy, S) * S + clampIx(X + dx, S)];
    child4(g(0, 0), g(-1, 0), g(1, 0), g(0, -1), g(0, 1), g(-1, -1), g(1, -1), g(-1, 1), g(1, 1), q);
    const o = 2 * Y * fn + 2 * X; out[o] = q[0]; out[o + 1] = q[1]; out[o + fn] = q[2]; out[o + fn + 1] = q[3];
  }
}
// the production carry (regional.ts refineSmooth): bilinear children, passes mean-restoring passes, then the limiter (when `limit`)
export type Lim = (v: number[], sum4: number, n9: number[]) => void; // n9: sw s se w c e nw n ne
export function prod(passes: number, limit: boolean | Lim = true): Variant {
  return (parent, S) => {
    const fn = 2 * S, c = new Float64Array(4 * S * S);
    children(parent, S, c);
    const r = new Float64Array(S * S), corr = new Float64Array(4 * S * S);
    for (let pass = 0; pass < passes; pass++) {
      for (let Y = 0; Y < S; Y++) for (let X = 0; X < S; X++) { const o = 2 * Y * fn + 2 * X; r[Y * S + X] = parent[Y * S + X] - (c[o] + c[o + 1] + c[o + fn] + c[o + fn + 1]) / 4; }
      children(r, S, corr);
      for (let i = 0; i < c.length; i++) c[i] += corr[i];
    }
    const out = new Int32Array(4 * S * S), lim: Lim | null = limit === true ? (v, s4, n9) => limitChildren(v, s4, Math.min(...n9), Math.max(...n9)) : limit || null;
    for (let Y = 0; Y < S; Y++) for (let X = 0; X < S; X++) {
      const o = 2 * Y * fn + 2 * X, v = [Math.round(c[o]), Math.round(c[o + 1]), Math.round(c[o + fn]), Math.round(c[o + fn + 1])], p = parent[Y * S + X];
      if (lim) {
        const n9: number[] = [];
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) n9.push(parent[clampIx(Y + dy, S) * S + clampIx(X + dx, S)]);
        lim(v, Math.round(p * 4), n9);
      } else {
        const d = Math.round(p * 4) - (v[0] + v[1] + v[2] + v[3]), base4 = Math.floor(d / 4), rem = d - base4 * 4;
        for (let k = 0; k < 4; k++) v[k] += base4 + (k < rem ? 1 : 0);
      }
      out[o] = v[0]; out[o + 1] = v[1]; out[o + fn] = v[2]; out[o + fn + 1] = v[3];
    }
    return out;
  };
}

export function carry(h0: Int32Array, S0: number, tiers: number, v: Variant | Variant[]): { h: Int32Array; S: number } {
  let h: Int32Array = h0, S = S0;
  for (let t = 0; t < tiers; t++) { const vv = Array.isArray(v) ? v[Math.min(t, v.length - 1)] : v; h = vv(Float64Array.from(h), S); S *= 2; }
  return { h, S };
}
// the central valid square of a carried window: the halo (6 cells at the tier above, 6/2^k later) thrown away
export function crop(h: Int32Array, S: number, S0: number, haloT0: number): { h: Int32Array; S: number } {
  const f = S / S0, m = Math.ceil(haloT0 * f), n = S - 2 * m, out = new Int32Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) out[y * n + x] = h[(y + m) * S + x + m];
  return { h: out, S: n };
}

// ---- variants of the limiter ----
// per-child bounds, then the parent's mean restored among the children that can still move (limitChildren's spreading, with a bound for each child)
export function restore(v: number[], sum4: number, lo: number[], hi: number[]) {
  const L = lo.map(Math.floor), H = hi.map(Math.ceil), free = [false, false, false, false];
  let sum = 0;
  for (let k = 0; k < 4; k++) { v[k] = Math.min(H[k], Math.max(L[k], v[k])); sum += v[k]; }
  for (let d = sum4 - sum; d !== 0; ) {
    let nf = 0;
    for (let k = 0; k < 4; k++) { free[k] = d > 0 ? v[k] < H[k] : v[k] > L[k]; if (free[k]) nf++; }
    if (nf === 0) break;
    const q = Math.floor(d / nf), rem = d - q * nf;
    let at = 0, moved = 0;
    for (let k = 0; k < 4; k++) if (free[k]) { const nw = Math.min(H[k], Math.max(L[k], v[k] + q + (at++ < rem ? 1 : 0))); moved += nw - v[k]; v[k] = nw; }
    d -= moved;
  }
}
// monotone along an axis only: where the parent's row (or column) of three is monotone, its children stay between the two neighbours; at a strict extremum of that axis they are free
export const axisMonotone: Lim = (v, s4, n9) => {
  const [, s, , w, c, e, , n] = n9, lo = [-Infinity, -Infinity, -Infinity, -Infinity], hi = [Infinity, Infinity, Infinity, Infinity];
  const mono = (a: number, b: number) => (a <= c && c <= b) || (a >= c && c >= b);
  let xl = -Infinity, xh = Infinity, yl = -Infinity, yh = Infinity;
  if (mono(w, e)) { xl = Math.min(w, e); xh = Math.max(w, e); }
  if (mono(s, n)) { yl = Math.min(s, n); yh = Math.max(s, n); }
  let l = Math.max(xl, yl), h = Math.min(xh, yh);
  if (l > h) { l = xl; h = xh; if (l === -Infinity && h === Infinity) { l = yl; h = yh; } }
  for (let k = 0; k < 4; k++) { lo[k] = l; hi[k] = h; }
  restore(v, s4, lo, hi);
};
// the same bound but only against the neighbours' extremes where the row or column is monotone AND the parent is not the extremum of the 3 x 3 (a cell is never held to its own value alone)
export const ENO: Variant = (parent, S) => {
  const fn = 2 * S, out = new Int32Array(4 * S * S);
  for (let Y = 0; Y < S; Y++) for (let X = 0; X < S; X++) {
    const g = (dx: number, dy: number) => parent[clampIx(Y + dy, S) * S + clampIx(X + dx, S)], a = g(0, 0);
    const eno = (l: number, r: number) => { const dl = a - l, dr = r - a; return Math.abs(dl) <= Math.abs(dr) ? dl : dr; };
    const sx = eno(g(-1, 0), g(1, 0)), sy = eno(g(0, -1), g(0, 1)), o = 2 * Y * fn + 2 * X;
    const v = [a - sx / 4 - sy / 4, a + sx / 4 - sy / 4, a - sx / 4 + sy / 4, a + sx / 4 + sy / 4].map(Math.round);
    const d = Math.round(a * 4) - (v[0] + v[1] + v[2] + v[3]), base4 = Math.floor(d / 4), rem = d - base4 * 4;
    for (let k = 0; k < 4; k++) v[k] += base4 + (k < rem ? 1 : 0);
    out[o] = v[0]; out[o + 1] = v[1]; out[o + fn] = v[2]; out[o + fn + 1] = v[3];
  }
  return out;
};

// children as the cell's quadratic (mean-preserving) reconstruction gives them: a +- gx/4 +- gy/4 with the central slopes (the children's cell means carry no curvature term); `bound` limits each slope to
// twice the smaller one-sided difference (MC limiter's third argument; the direction stays the central one, so a strict extremum is not flattened)
export const slopes = (bound: boolean): Variant => (parent, S) => {
  const fn = 2 * S, out = new Int32Array(4 * S * S);
  for (let Y = 0; Y < S; Y++) for (let X = 0; X < S; X++) {
    const g = (dx: number, dy: number) => parent[clampIx(Y + dy, S) * S + clampIx(X + dx, S)], a = g(0, 0);
    const sl = (l: number, r: number) => { const c = (r - l) / 2; if (!bound) return c; const m = 2 * Math.min(Math.abs(a - l), Math.abs(r - a)); return Math.abs(c) > m ? Math.sign(c) * m : c; };
    const sx = sl(g(-1, 0), g(1, 0)), sy = sl(g(0, -1), g(0, 1)), o = 2 * Y * fn + 2 * X;
    const v = [a - sx / 4 - sy / 4, a + sx / 4 - sy / 4, a - sx / 4 + sy / 4, a + sx / 4 + sy / 4].map(Math.round);
    const d = Math.round(a * 4) - (v[0] + v[1] + v[2] + v[3]), base4 = Math.floor(d / 4), rem = d - base4 * 4;
    for (let k = 0; k < 4; k++) v[k] += base4 + (k < rem ? 1 : 0);
    out[o] = v[0]; out[o + 1] = v[1]; out[o + fn] = v[2]; out[o + fn + 1] = v[3];
  }
  return out;
};

// Barth-Jespersen's range, but a strict extremum of its 3 x 3 may let its children out of the range by as much as it stands out of it (the nearest neighbour's step, as Suresh and Huynh's MP bound
// extends a limit by a multiple of the local difference): a peak then keeps a sub-cell crest and a pit a sub-cell floor, while a plateau's edge (a tie with a neighbour) stays held.
export const PBJ: Lim = (v, s4, n9) => {
  const a = n9[4], nb = n9.filter((_, i) => i !== 4), lo8 = Math.min(...nb), hi8 = Math.max(...nb);
  const hi = a > hi8 ? 2 * a - hi8 : hi8, lo = a < lo8 ? 2 * a - lo8 : lo8;
  restore(v, s4, [lo, lo, lo, lo], [hi, hi, hi, hi]);
};

// A child may disagree with the sea level of its parents only where some parent in the 3 x 3 does too: where all nine parents are land (or all sea) and a child is not, the children are held to the
// parents' range (Barth-Jespersen); everywhere else the carry is free (a coast may move inside the cells that hold it).
export const SEAJ: Lim = (v, s4, n9) => {
  const lo = Math.min(...n9), hi = Math.max(...n9), bad = (lo > 0 && Math.min(...v) <= 0) || (hi <= 0 && Math.max(...v) > 0);
  if (bad) limitChildren(v, s4, lo, hi);
  else restore(v, s4, [-Infinity, -Infinity, -Infinity, -Infinity], [Infinity, Infinity, Infinity, Infinity]);
};

// The sea level's maximum principle by Zhang and Shu's scaling (J. Comput. Phys. 229:3091, 2010; Proc. R. Soc. A 467:2752, 2011): where all nine parents are land (or all sea), children are scaled toward their parent's
// mean, v' = a + theta (v - a), by the largest theta <= 1 that keeps them on that side of the sea level (one unit off it); the mean is kept, nothing else is clamped, so no block goes constant that the sea level
// does not force.
export const ZS: Lim = (v, s4, n9) => {
  const lo = Math.min(...n9), hi = Math.max(...n9), mean = s4 / 4, I = Infinity;
  let theta = 1, bl = -I, bh = I;
  if (lo > 0) { bl = 1; const m = Math.min(...v); if (m < 1) theta = Math.max(0, (mean - 1) / (mean - m)); }
  else if (hi <= 0) { bh = -1; const M = Math.max(...v); if (M > -1) theta = Math.max(0, (-1 - mean) / (M - mean)); }
  if (theta < 1) for (let k = 0; k < 4; k++) v[k] = Math.round(mean + theta * (v[k] - mean));
  restore(v, s4, [bl, bl, bl, bl], [bh, bh, bh, bh]);
};

// The sea-level principle on the four edge neighbours: a child of a land parent is held one unit above the sea only when both parents that share an edge with it (the one on its x side and the one on its y
// side) are land too (a sea cell touching its parent's corner only does not let sea into the child: a coast moves inside the cells that share an edge with the sea); the children's scaling toward the mean as ZS.
export const ZS4: Lim = (v, s4, n9) => {
  const [, s, , w, c, e, , n] = n9, mean = s4 / 4, I = Infinity;
  const landP = c > 0 && s4 >= 4, seaP = !landP && c <= 0;
  const sx = [w, e, w, e], sy = [s, s, n, n], lo = [-I, -I, -I, -I], hi = [I, I, I, I];
  for (let k = 0; k < 4; k++) {
    if (landP && sx[k] > 0 && sy[k] > 0) lo[k] = 1;
    else if (seaP && sx[k] <= 0 && sy[k] <= 0) hi[k] = -1;
  }
  let theta = 1;
  for (let k = 0; k < 4; k++) {
    if (lo[k] === 1 && v[k] < 1) theta = Math.min(theta, Math.max(0, (mean - 1) / (mean - v[k])));
    if (hi[k] === -1 && v[k] > -1) theta = Math.min(theta, Math.max(0, (-1 - mean) / (v[k] - mean)));
  }
  if (theta < 1) for (let k = 0; k < 4; k++) v[k] = Math.round(mean + theta * (v[k] - mean));
  restore(v, s4, lo, hi);
};
