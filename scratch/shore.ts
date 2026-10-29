// Shore stage: a cell model of coastline evolution on the low coasts of a tier-5 region state, bun shore.ts <rX> <land dir in> <land dir out prefix> <years[,years..]> [seed=1]
//
// Source model: Ashton, Murray and Arnoult 2001 (Nature 414: 296-300) and Ashton and Murray 2006 (JGR 111, F04011, "High-angle wave instability and emergent shoreline shapes 1"), in the
// form of the CSDMS CEM code (github.com/csdms-contrib/cem, cem/cem.c, read function by function; MIT licence). Rules kept, with the CEM function they come from:
//   cell F       fraction of a cell filled with sand, 0..1 (PercentFullSand); F = 1 is "AllBeach". Sand is conserved: the sum of F x cell^2 x D never changes except where noted below.
//   shore chain  the cells with F > 0 that have a 4-neighbour with F = 0, walked as closed loops with the sea on the right (FindBeachCells / FindNextCell: wall-following in the cells; here
//                the square-tracing rule on edges, land 4-connected, as scripts/gates/straight.ts does, so islands, bays and lakes need no special case). A cell may be on the chain twice (a spit).
//   wave         one deep-water wave direction per time step, drawn from a distribution (FindWaveAngle); the CEM draws from asymmetry A and highness U, here the distribution is the
//                planet's own: wind-relative cos^2 directions, heights from the fetch (see the climate block). The CEM's A and U then come out of the coast's orientation.
//   shadow       a shore cell is in shadow when the shore itself lies between it and the waves (ShadowSweep / FindIfInShadow marches a ray back along the wave direction at 0.2 cell steps
//                and stops on a full cell). Here the same test as a depth buffer over the chain's sub-cell points (1 cell wide ray strips, 1.5 cells of slack), O(chain) not O(chain x ray).
//   angles       the CEM takes the shore angle of a link from the cells' (x + F) positions and averages the two links round a cell (DetermineAngles). Here a link's orientation is the mean of
//                the two cells' tangents, and a cell's tangent is the normal of the 5 by 5 smoothed F field [design: the CEM's staircase angle would put the 0/90 degree lattice into the flux].
//   flux         across the border of two chain cells, Q = K H0^(12/5) T^(1/5) cos^(6/5)(phi) sin(phi), phi the angle between the deep-water wave and the shore normal, K = 0.34 m^(3/5) s^(-6/5),
//                Q in m3/s of deposited sand, H0 the rms deep-water wave height (Ashton and Murray 2006a, eq. 1 as printed in Ashton, Murray and Littlewood 2007, Coastal Sediments '07,
//                "The response of spit shapes to wave-angle climates"; maximum at 42 degrees). The CEM codes the refracted CERC form; this is the deep-water form the 2006 paper uses.
//   upwind       (DetermineAngles, DetermineSedTransport) the transport goes to the right when the wave angle exceeds the link angle; the cell it leaves is the source cell; if the wave is at
//                42 degrees or more to that cell's own orientation ("high angle", the 42 deg test of DetermineAngles) the link UPWIND of the source cell gives the angle, else the link
//                between the two cells; where a low-angle cell is followed by a high-angle one the flux is that of 42 degrees (MaxTrans); a shadowed source gives none, sand is put into a
//                shadowed next cell using the upwind angle, a shadowed cell upwind of a high-angle source gives none. Waves 89.55 degrees or more off the normal give none (SedTrans).
//   limiter      (FlowInCell, FixFlow) each cell is Right, Left, Convergent or Divergent by the directions of its two borders; a divergent cell gives its two borders at most the sand it holds
//                (plus the full cell behind it, AdjustShore's "AmountSand"), shared in proportion; a right (left) cell passes on at most what comes in plus what it holds.
//   update       (AdjustShore) dF = (in - out) / (cell^2 D) with D the active profile depth; (TransportSedimentSweep) swept in a random direction; F over 1: OopsImFull puts the excess
//                equally into the 4-neighbours with F = 0, else into those with F < 1, else it is lost; F under 0: OopsImEmpty takes the deficit equally from the 4-neighbours that are full,
//                else from those with F > 0; (FixBeach) loose sand (a partial cell with no full 4-neighbour) is moved to partial neighbours or the nearest full cell. Overwash, rock
//                weathering, sinks and the SWAN coupling of the CEM are not used.
//   rock         a cell is mobile only if every land cell within 3 cells (Chebyshev) is at or under 3 m [design: a beach and dune ridge, the CEM's own LAND_HEIGHT is 1 m and the spit runs of
//                Ashton et al. 2015 use 1 m], and it is not in a pit or the frozen margin. Immobile cells keep F; no sand crosses a border to or from one (the CEM's rock cells). The
//                chain still passes through them and they cast shadows.
//   F from h     F = clamp(0.5 + h / |grad h| in cells, 0, 1): the cell's h over the local slope is the distance to the 0 contour in cells, so the contour is where it was (a plain of
//                0.1 m per cell gives partial cells a few cells wide, a cliff gives none). Written back: a cell whose side of F = 0.5 changed gets h = (F - 0.5) x 1e-3 x 75 m (at least 1/256 m
//                in magnitude, continuous with F; 1e-3 is the shelf and plain gradient of order 1e-3 [design]); every other cell keeps its height.
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { PLANET_RADIUS_M, eastNorth, locateVec, pointAt, tierGrid, type V3 } from "../src/gpu/globe/grid";
import { SEA_WIND_STEP_DEG, seaWindTable } from "../src/gpu/globe/seawind";

const REG: Record<string, [number, number, number]> = { rA: [4, 24, 20], rR: [1, 14, 10], rK: [1, 6, 6], rB: [1, 1, 6], rL: [1, 14, 18], rH: [4, 26, 25] };
const S = 1024, N = S * S, CELL = 75, G = 9.81;
const [name, srcDir, dstPrefix, yearsArg, seedArg] = process.argv.slice(2);
const years = yearsArg.split(",").map(Number), SEED = Number(seedArg ?? 1) >>> 0;
const [face, tx, ty] = REG[name];
const FROZEN = 32;      // cells at the window's edge that never change [design: the harness holds a ring of 64; the pictures keep 64 off the edge]
const H_LOW = 3;        // m, a low coast's land within 3 cells is under this [design]
const SLOPE = 1e-3;     // m per m, the gradient that gives a changed cell its height [design]
const K = 0.34;         // m^(3/5) s^(-6/5), Ashton and Murray 2006a via Ashton, Murray and Littlewood 2007 eq. 1
const FRAC = Number(process.env.SHORE_DTFRAC ?? 0.3); // the most a border may move of a cell's volume in one step (CEM: a day of the 0.1..1 day steps it ran)
const MAXSTEPS = Number(process.env.SHORE_MAXSTEPS ?? 1e12);
const SHAPE_MAX = Math.cos(42 * Math.PI / 180) ** 1.2 * Math.sin(42 * Math.PI / 180), COS42 = Math.cos(42 * Math.PI / 180), COS_MIN = Math.cos(89.55 * Math.PI / 180);

// ---------- the state ----------
const raw = readFileSync(`${srcDir}/${name}/state.i32`);
const h0 = new Int32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
if (h0.length !== N) throw new Error("state size");

// ocean: water cells (h <= 0) 4-connected to the window's edge or in a body of 4096 cells or more; the rest are pits (kept as land, immobile)
const water = new Uint8Array(N), pit = new Uint8Array(N);
{
  const lab = new Int32Array(N), stack: number[] = [];
  for (let k = 0; k < N; k++) if (h0[k] <= 0 && !lab[k]) {
    let n = 0, edge = false; stack.push(k); lab[k] = 1; const members: number[] = [];
    while (stack.length) {
      const c = stack.pop()!; members.push(c); n++;
      const x = c % S, y = (c / S) | 0; if (x === 0 || y === 0 || x === S - 1 || y === S - 1) edge = true;
      for (const d of [1, -1, S, -S]) { const m = c + d; if ((d === 1 && x === S - 1) || (d === -1 && x === 0) || m < 0 || m >= N) continue; if (h0[m] <= 0 && !lab[m]) { lab[m] = 1; stack.push(m); } }
    }
    const ocean = edge || n >= 4096;
    for (const c of members) { if (ocean) water[c] = 1; else pit[c] = 1; }
  }
}
const F = new Float64Array(N), mobile = new Uint8Array(N);
for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
  const k = y * S + x;
  if (pit[k]) { F[k] = 1; continue; }
  const xl = Math.max(0, x - 1), xr = Math.min(S - 1, x + 1), yu = Math.max(0, y - 1), yd = Math.min(S - 1, y + 1);
  const gx = (h0[y * S + xr] - h0[y * S + xl]) / 256 / (xr - xl), gy = (h0[yd * S + x] - h0[yu * S + x]) / 256 / (yd - yu);
  const g = Math.max(Math.hypot(gx, gy), 1 / 256);
  F[k] = Math.min(1, Math.max(0, 0.5 + h0[k] / 256 / g));
}
{
  const L = new Float32Array(N).fill(-1e9), rowMax = new Float32Array(N), mx = new Float32Array(N);
  for (let k = 0; k < N; k++) if (h0[k] > 0 && !pit[k]) L[k] = h0[k] / 256;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) { let m = -1e9; for (let d = -3; d <= 3; d++) { const xx = x + d; if (xx >= 0 && xx < S) m = Math.max(m, L[y * S + xx]); } rowMax[y * S + x] = m; }
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) { let m = -1e9; for (let d = -3; d <= 3; d++) { const yy = y + d; if (yy >= 0 && yy < S) m = Math.max(m, rowMax[yy * S + x]); } mx[y * S + x] = m; }
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) { const k = y * S + x; mobile[k] = !pit[k] && x >= FROZEN && y >= FROZEN && x < S - FROZEN && y < S - FROZEN && mx[k] <= H_LOW ? 1 : 0; }
}
const F0 = Float64Array.from(F);

// ---------- the chain ----------
const DX = [-1, 0, 1, 0], DY = [0, -1, 0, 1];       // travel direction of an edge of side N, E, S, W with the sea on the right (y down)
const NX = [0, 1, 0, -1], NY = [-1, 0, 1, 0];       // the side's outward normal
const LEFT = [3, 0, 1, 2], RIGHT = [1, 2, 3, 0];
const sand = (x: number, y: number) => x >= 0 && y >= 0 && x < S && y < S && F[y * S + x] > 0;
const bnd = new Uint8Array(N), inList = new Uint8Array(N), cand = new Int32Array(N), dirtyAt = new Int32Array(N);
let blist = new Int32Array(N >> 3), nb = 0, step = 0, dirty: number[] = [];
const mark = (c: number) => { if (dirtyAt[c] !== step + 1) { dirtyAt[c] = step + 1; dirty.push(c); } };
function maskOf(c: number): number {
  if (!(F[c] > 0)) return 0;
  const x = c % S, y = (c / S) | 0; let m = 0;
  for (let s = 0; s < 4; s++) if (!sand(x + NX[s], y + NY[s])) m |= 1 << s;
  return m;
}
function setMask(c: number) {
  const m = maskOf(c); bnd[c] = m;
  if (m && !inList[c]) { inList[c] = 1; if (nb === blist.length) { const b = new Int32Array(blist.length * 2); b.set(blist); blist = b; } blist[nb++] = c; }
}
function refreshBoundary(all: boolean) {
  if (all) { for (let c = 0; c < N; c++) setMask(c); }
  else {
    const stamp = step + 1;
    for (const d of dirty) { const x = d % S, y = (d / S) | 0; for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) { const X = x + i, Y = y + j; if (X < 0 || Y < 0 || X >= S || Y >= S) continue; const c = Y * S + X; if (cand[c] === stamp) continue; cand[c] = stamp; setMask(c); } }
  }
  let w = 0; for (let i = 0; i < nb; i++) { const c = blist[i]; if (bnd[c]) blist[w++] = c; else inList[c] = 0; } nb = w;
  dirty = [];
}

// visits of the chain (a cell is visited once per run of its edges)
const MAXV = 1 << 19;
const vc = new Int32Array(MAXV), vnx = new Float64Array(MAXV), vny = new Float64Array(MAXV), vtx = new Float64Array(MAXV), vty = new Float64Array(MAXV), vpx = new Float64Array(MAXV), vpy = new Float64Array(MAXV);
const vsh = new Uint8Array(MAXV), vhi = new Uint8Array(MAXV), vmob = new Uint8Array(MAXV), vfirst = new Uint8Array(MAXV);
const ltx = new Float64Array(MAXV), lty = new Float64Array(MAXV), vab = new Float64Array(MAXV), act = new Float64Array(MAXV), vdir = new Uint8Array(MAXV);
const loopA: number[] = [], loopB: number[] = []; // [start, end) of each loop in the visit arrays
const edgeVis = new Int32Array(N * 4), SM = [1, 4, 6, 4, 1], DV = [-1, -2, 0, 2, 1];
let nv = 0, loopStamp = 0;
const fAt = (x: number, y: number) => F[Math.min(S - 1, Math.max(0, y)) * S + Math.min(S - 1, Math.max(0, x))];
function buildChain() {
  nv = 0; loopA.length = 0; loopB.length = 0; loopStamp++;
  for (let b = 0; b < nb; b++) {
    const c0 = blist[b];
    for (let s0 = 0; s0 < 4; s0++) {
      if (!(bnd[c0] & (1 << s0)) || edgeVis[c0 * 4 + s0] === loopStamp) continue;
      const a = nv; let e = c0 * 4 + s0, guard = 0;
      do {
        edgeVis[e] = loopStamp;
        const c = e >> 2, s = e & 3;
        if (nv === a || vc[nv - 1] !== c) { if (nv >= MAXV) throw new Error("chain too long"); vc[nv] = c; vfirst[nv] = s; nv++; }
        const x = c % S, y = (c / S) | 0, flx = x + DX[s], fly = y + DY[s];
        if (!sand(flx, fly)) e = c * 4 + LEFT[s];
        else if (!sand(flx + NX[s], fly + NY[s])) e = (fly * S + flx) * 4 + s;
        else e = ((fly + NY[s]) * S + flx + NX[s]) * 4 + RIGHT[s];
        if (++guard > 4 * N) throw new Error("loop runs away");
      } while (e !== c0 * 4 + s0 && edgeVis[e] !== loopStamp);
      // a loop whose first and last visits are one cell: merge
      if (nv - a > 1 && vc[nv - 1] === vc[a]) nv--;
      loopA.push(a); loopB.push(nv);
    }
  }
  // geometry of every visit: the normal of the smoothed F, the sub-cell point
  for (let i = 0; i < nv; i++) {
    const c = vc[i], x = c % S, y = (c / S) | 0;
    let gx = 0, gy = 0;
    for (let j = -2; j <= 2; j++) for (let k = -2; k <= 2; k++) { const f = fAt(x + k, y + j); gx += SM[j + 2] * DV[k + 2] * f; gy += SM[k + 2] * DV[j + 2] * f; }
    const gm = Math.hypot(gx, gy);
    let nx: number, ny: number;
    if (gm > 1e-9) { nx = -gx / gm; ny = -gy / gm; } else { nx = NX[vfirst[i]]; ny = NY[vfirst[i]]; }
    vnx[i] = nx; vny[i] = ny; vtx[i] = ny; vty[i] = -nx;
  }
  for (let l = 0; l < loopA.length; l++) {
    const a = loopA[l], m = loopB[l] - a;
    for (let i = 0; i < m; i++) {
      // the normal must agree with the walk (sea on the right, t = (ny, -nx)); where it does not (a one-cell spit) the edge's own side is used
      const p = a + (i + m - 1) % m, q = a + (i + 1) % m, v = a + i;
      const fx = (vc[q] % S) - (vc[p] % S), fy = ((vc[q] / S) | 0) - ((vc[p] / S) | 0);
      if (vtx[v] * fx + vty[v] * fy < 0) { vnx[v] = NX[vfirst[v]]; vny[v] = NY[vfirst[v]]; vtx[v] = vny[v]; vty[v] = -vnx[v]; }
    }
  }
  for (let i = 0; i < nv; i++) {
    const c = vc[i], x = c % S + 0.5, y = ((c / S) | 0) + 0.5, f = Math.min(1, F[c]), wdt = Math.abs(vnx[i]) + Math.abs(vny[i]);
    vpx[i] = x + (f - 0.5) * wdt * vnx[i]; vpy[i] = y + (f - 0.5) * wdt * vny[i]; vmob[i] = mobile[c];
  }
}

// ---------- the wave climate ----------
// Site: the mean position of the low chain's cells. Wind: seawind.ts (zonal mean scalar wind and its direction at the latitude). Directions: the waves come from the wind's side with a
// cos^2 spread to either side [design: the cos^2 directional spreading of a wind sea, as in Mitsuyasu et al. 1975's cos^2s with s = 1; the zonal mean gives one direction only]. Speeds: Rayleigh with
// the scalar wind as mean, cut at the speed exceeded 12 h a year (2.90 times the mean, the same storm class as He; winds above it are not counted [design]). Fetch: the open water upwind from the site on the tier-0 planet, 600 km at most. Heights and periods: fetch-limited growth, the JONSWAP fits of the US Army Corps
// Shore Protection Manual 1984 (eqs. 3-28 to 3-30: U_A = 0.71 U^1.23, gH/U_A^2 = 1.6e-3 (gF/U_A^2)^(1/2) to 0.243, gT/U_A = 0.286 (gF/U_A^2)^(1/3) to 8.134). Flux weight of a direction:
// E = mean over speeds of H_rms^(12/5) T^(1/5), H_rms = Hs / sqrt 2 (Rayleigh heights). Depth of the active profile: Hallermeier 1981 d_c = 2.28 He - 68.5 He^2 / (g Te^2), He the
// significant height exceeded 12 h a year: the speed exceeded 12 h a year in a Rayleigh wind, 2.90 times its mean, in the most exposed direction, plus the berm height.
type Dir = { wx: number; wy: number; p: number; E: number; fetchKm: number };
const g5 = tierGrid(5, PLANET_RADIUS_M), g0 = tierGrid(0, PLANET_RADIUS_M);
function climate(sx: number, sy: number, berm: number) {
  const X = tx * 256 + sx, Y = ty * 256 + sy, p = pointAt(g5, face, X, Y), px = pointAt(g5, face, X + 1, Y), mx = pointAt(g5, face, X - 1, Y), py = pointAt(g5, face, X, Y + 1), my = pointAt(g5, face, X, Y - 1);
  const unit = (a: V3, b: V3): V3 => { const d = [a[0] - b[0], a[1] - b[1], a[2] - b[2]], n = Math.hypot(d[0], d[1], d[2]); return [d[0] / n, d[1] / n, d[2] / n]; };
  const ex = unit(px, mx), ey = unit(py, my), [east, north] = eastNorth(p);
  const lat = Math.atan2(p[2], Math.hypot(p[0], p[1])) * 180 / Math.PI, lon = Math.atan2(p[1], p[0]) * 180 / Math.PI;
  const wt = seaWindTable(), i = Math.round((lat + 90) / SEA_WIND_STEP_DEG), U = wt.speed[i];
  const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const toward = Math.atan2(wt.east[i], wt.north[i]); // bearing the wind blows toward
  const fromW = toward + Math.PI;                      // bearing it blows from
  const h0f = new Float32Array(new Uint8Array(readFileSync(process.env.SHORE_H0 ?? "/Users/adamstockermans/.cache/nomads-scratch/t7/raw/height.f32")).buffer);
  const fetch = (bearing: number) => {
    const dir: V3 = [Math.sin(bearing) * east[0] + Math.cos(bearing) * north[0], Math.sin(bearing) * east[1] + Math.cos(bearing) * north[1], Math.sin(bearing) * east[2] + Math.cos(bearing) * north[2]];
    let sea0 = -1, s = 0;
    for (; s <= 600e3; s += 1200) {
      const a = s / PLANET_RADIUS_M, q: V3 = [Math.cos(a) * p[0] + Math.sin(a) * dir[0], Math.cos(a) * p[1] + Math.sin(a) * dir[1], Math.cos(a) * p[2] + Math.sin(a) * dir[2]];
      const pl = locateVec(g0, q), land = h0f[(pl.face * 256 + pl.Y) * 256 + pl.X] > 0;
      if (sea0 < 0) { if (!land) sea0 = s; else if (s > 8000) return 0; } else if (land) return Math.max(2400, s - sea0);
    }
    return sea0 < 0 ? 0 : 600e3;
  };
  const waves = (u: number, Fm: number) => {
    const UA = 0.71 * u ** 1.23, x = G * Fm / (UA * UA);
    return { H: Math.min(1.6e-3 * Math.sqrt(x), 0.243) * UA * UA / G, T: Math.min(0.286 * x ** (1 / 3), 8.134) * UA / G };
  };
  const dirs: Dir[] = []; let psum = 0, He = 0, Te = 0;
  const sigma = U / Math.sqrt(Math.PI / 2);
  for (let d = -87.5; d <= 87.5; d += 5) {
    const psi = fromW + d * Math.PI / 180, F_ = fetch(psi), pr = Math.cos(d * Math.PI / 180) ** 2;
    let E = 0;
    if (F_ > 0) for (let u = U / 60, du = U / 30; u < 2.9 * U; u += du) { const w = waves(u, F_), pdf = u / (sigma * sigma) * Math.exp(-u * u / (2 * sigma * sigma)) * du; E += pdf * (w.H / Math.SQRT2) ** 2.4 * w.T ** 0.2; }
    const ue = 2.90 * U, we = waves(ue, F_); if (F_ > 0 && we.H > He) { He = we.H; Te = we.T; }
    const v: V3 = [-(Math.sin(psi) * east[0] + Math.cos(psi) * north[0]), -(Math.sin(psi) * east[1] + Math.cos(psi) * north[1]), -(Math.sin(psi) * east[2] + Math.cos(psi) * north[2])];
    const wx = dot(v, ex), wy = dot(v, ey), n = Math.hypot(wx, wy);
    dirs.push({ wx: wx / n, wy: wy / n, p: pr, E, fetchKm: F_ / 1e3 }); psum += pr;
  }
  for (const d of dirs) d.p /= psum;
  const dc = Math.max(1, 2.28 * He - 68.5 * He * He / (G * Te * Te));
  return { lat, lon, U, windToward: toward * 180 / Math.PI, He, Te, dc, D: dc + berm, dirs };
}

// ---------- the step ----------
let rs = SEED || 1;
const rnd = () => { rs = (rs + 0x9e3779b9) | 0; let z = rs; z = Math.imul(z ^ (z >>> 16), 0x85ebca6b); z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35); z ^= z >>> 16; return (z >>> 0) / 4294967296; };
let lost = 0;
function oopsFull(c: number) {
  const x = c % S, y = (c / S) | 0, ex = F[c] - 1, nbs: number[] = [];
  for (let s = 0; s < 4; s++) { const X = x + NX[s], Y = y + NY[s]; if (X < 0 || Y < 0 || X >= S || Y >= S) continue; const k = Y * S + X; if (mobile[k] && F[k] === 0) nbs.push(k); }
  if (!nbs.length) for (let s = 0; s < 4; s++) { const X = x + NX[s], Y = y + NY[s]; if (X < 0 || Y < 0 || X >= S || Y >= S) continue; const k = Y * S + X; if (mobile[k] && F[k] < 1) nbs.push(k); }
  if (!nbs.length) { mark(c); return; } // nowhere to put it: the cell holds it over 1 and tries again next step (sand is conserved; the CEM drops it)
  for (const k of nbs) { F[k] += ex / nbs.length; mark(k); }
  F[c] = 1; mark(c);
}
function oopsEmpty(c: number) {
  const x = c % S, y = (c / S) | 0, neg = F[c], nbs: number[] = [];
  for (let s = 0; s < 4; s++) { const X = x + NX[s], Y = y + NY[s]; if (X < 0 || Y < 0 || X >= S || Y >= S) continue; const k = Y * S + X; if (mobile[k] && F[k] >= 1) nbs.push(k); }
  if (!nbs.length) for (let s = 0; s < 4; s++) { const X = x + NX[s], Y = y + NY[s]; if (X < 0 || Y < 0 || X >= S || Y >= S) continue; const k = Y * S + X; if (mobile[k] && F[k] > 0) nbs.push(k); }
  if (!nbs.length) { mark(c); return; }
  for (const k of nbs) { F[k] += neg / nbs.length; mark(k); }
  F[c] = 0; mark(c);
}
function fixBeach() {
  const seen = new Set<number>(), list: number[] = [];
  for (const d of dirty) { const x = d % S, y = (d / S) | 0; for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) { const X = x + i, Y = y + j; if (X < 0 || Y < 0 || X >= S || Y >= S) continue; const c = Y * S + X; if (!seen.has(c)) { seen.add(c); list.push(c); } } }
  for (let it = 0; it < 3; it++) {
    for (const c of list) {
      if (!mobile[c]) continue;
      if (F[c] < -1e-6) oopsEmpty(c); else if (F[c] > 1) oopsFull(c);
      else if (F[c] < 1e-9 && F[c] !== 0) { F[c] = 0; mark(c); }
    }
  }
  for (const c of list) {
    if (!mobile[c] || !(F[c] > 0 && F[c] < 1)) continue;
    const x = c % S, y = (c / S) | 0; let full = false; const part: number[] = [];
    for (let s = 0; s < 4; s++) { const X = x + NX[s], Y = y + NY[s]; if (X < 0 || Y < 0 || X >= S || Y >= S) continue; const k = Y * S + X; if (F[k] >= 1) full = true; else if (F[k] > 0 && mobile[k]) part.push(k); }
    if (full) continue;
    if (part.length) { for (const k of part) { F[k] += F[c] / part.length; mark(k); } F[c] = 0; mark(c); continue; }
    let best = -1, bd = 1e9;
    for (let j = -4; j <= 4; j++) for (let i = -4; i <= 4; i++) { const X = x + i, Y = y + j; if (X < 0 || Y < 0 || X >= S || Y >= S) continue; const k = Y * S + X; if (mobile[k] && F[k] >= 1 && i * i + j * j < bd) { bd = i * i + j * j; best = k; } }
    if (best >= 0) { F[best] += F[c]; mark(best); F[c] = 0; mark(c); }
  }
}

const zbuf = new Float64Array(4 * S + 8);
let nShadow = 0, nFlux = 0;
function transport(wx: number, wy: number, amp: number, dt: number, V: number) {
  // shadows
  const ox = 2 * S, qx = -wy, qy = wx;
  const used: number[] = [];
  for (let i = 0; i < nv; i++) { const b = Math.floor(vpx[i] * qx + vpy[i] * qy + ox); if (zbuf[b] === 0) { zbuf[b] = -1e18; used.push(b); } }
  for (let i = 0; i < nv; i++) { const b = Math.floor(vpx[i] * qx + vpy[i] * qy + ox), u = -(vpx[i] * wx + vpy[i] * wy); if (u > zbuf[b]) zbuf[b] = u; }
  for (let i = 0; i < nv; i++) { const b = Math.floor(vpx[i] * qx + vpy[i] * qy + ox), u = -(vpx[i] * wx + vpy[i] * wy); vsh[i] = u < zbuf[b] - 1.5 ? 1 : 0; vhi[i] = -(wx * vnx[i] + wy * vny[i]) <= COS42 ? 1 : 0; }
  for (const b of used) zbuf[b] = 0;
  for (let l = 0; l < loopA.length; l++) {
    const a = loopA[l], m = loopB[l] - a;
    if (m < 3) { for (let i = a; i < a + m; i++) { vab[i] = 0; act[i] = 0; vdir[i] = 1; } continue; }
    const at = (k: number) => a + (((k - a) % m) + m) % m;
    // links and directions
    for (let i = a; i < a + m; i++) {
      const j = at(i + 1); let lx = vtx[i] + vtx[j], ly = vty[i] + vty[j]; const ln = Math.hypot(lx, ly);
      if (ln < 0.2) { lx = vtx[i]; ly = vty[i]; } else { lx /= ln; ly /= ln; }
      ltx[i] = lx; lty[i] = ly; vdir[i] = wx * lx + wy * ly > 0 ? 1 : 0;
    }
    for (let i = a; i < a + m; i++) {
      vab[i] = 0;
      const j = at(i + 1);
      if (!vmob[i] || !vmob[j]) continue;
      const r = vdir[i] === 1, cc = r ? i : j;
      const next = r ? at(cc + 1) : at(cc - 1), last = r ? at(cc - 1) : at(cc + 1);
      if (vsh[cc]) continue;
      const maxT = (!vhi[cc] && vhi[next] && !vsh[next]) || (vhi[last] && !vhi[cc] && !vsh[last]);
      let up = vhi[cc] === 1; if (vsh[next]) up = true;
      if (vsh[last] && up) continue;
      const k = up ? (r ? at(i - 1) : at(i + 1)) : i;
      const cs = wx * lty[k] - wy * ltx[k]; // -(w . n), n = (-ty, tx)
      if (cs <= COS_MIN) continue;
      const sn = wx * ltx[k] + wy * lty[k];
      vab[i] = amp * dt * (maxT ? SHAPE_MAX : cs ** 1.2 * Math.abs(sn));
    }
    // the limiter
    for (let i = a; i < a + m; i++) act[i] = vab[i];
    const avail = (i: number) => {
      const c = vc[i], x = c % S, y = (c / S) | 0, bx = x - Math.round(vnx[i]), by = y - Math.round(vny[i]);
      let f = F[c]; if (bx >= 0 && by >= 0 && bx < S && by < S) { const k = by * S + bx; if (mobile[k] && F[k] >= 1) f += F[k]; }
      return Math.max(0, f) * V;
    };
    for (let i = a; i < a + m; i++) {
      const p = at(i - 1);
      if (vdir[p] === 0 && vdir[i] === 1) { const A = avail(i), s = vab[p] + vab[i]; if (s > A) { act[i] = vab[i] / s * A; act[p] = vab[p] / s * A; } }
    }
    for (let round = 0; round < 2; round++) {
      for (let i = a; i < a + m; i++) { const p = at(i - 1); if (vdir[p] === 1 && vdir[i] === 1) { const A = avail(i); act[i] = act[p] + A >= vab[i] ? vab[i] : act[p] + A; } }
      for (let i = a + m - 1; i >= a; i--) { const p = at(i - 1); if (vdir[p] === 0 && vdir[i] === 0) { const A = avail(i); act[p] = act[i] + A >= vab[p] ? vab[p] : act[i] + A; } }
    }
  }
  // apply
  const fwd = rnd() < 0.5;
  for (let l = 0; l < loopA.length; l++) {
    const a = loopA[l], m = loopB[l] - a; if (m < 3) continue;
    const at = (k: number) => a + (((k - a) % m) + m) % m;
    for (let q = 0; q < m; q++) {
      const i = a + (fwd ? q : m - 1 - q), p = at(i - 1);
      if (!vmob[i]) continue;
      const dl = vdir[p], dr = vdir[i];
      const net = dl === 1 && dr === 1 ? act[p] - act[i] : dl === 1 ? act[p] + act[i] : dr === 1 ? -(act[p] + act[i]) : act[i] - act[p];
      if (net !== 0) { nFlux++; const c = vc[i]; F[c] += net / V; mark(c); if (F[c] < -1e-6) oopsEmpty(c); else if (F[c] > 1) oopsFull(c); }
    }
  }
}

// Overwash (CheckOverwash, DoOverwash with OWType 1 and the back-barrier depth equal to the shoreface depth as in Ashton et al. 2015, Earth Surf. Dynam. Discuss. 3: 515): from each unshadowed
// mobile shore cell a ray goes back along the cell's normal; if after crossing a full cell it reaches a cell that is not full within the critical barrier width (350 m, CEM consts.h CritBWidth), sand
// moves from the front cell to that back cell, at most MaxOver = 0.01 of a cell per day (consts.h). CEM runs it in every step; here every 4th step with the days of the four.
const WC = 350 / CELL;
function overwash(dtDays: number) {
  const amount = 0.01 * dtDays;
  for (let i = 0; i < nv; i++) {
    if (!vmob[i] || vsh[i]) continue;
    const c = vc[i]; if (F[c] < amount) continue;
    const dx = -vnx[i], dy = -vny[i]; let full = false;
    for (let s = 0.25; s <= WC; s += 0.25) {
      const X = Math.floor(vpx[i] + dx * s), Y = Math.floor(vpy[i] + dy * s); if (X < 0 || Y < 0 || X >= S || Y >= S) break;
      const k = Y * S + X; if (k === c) continue;
      if (F[k] >= 1) { full = true; continue; }
      if (!full) continue;
      if (s >= 1.5 && s + F[k] < WC && mobile[k]) { F[c] -= amount; F[k] += amount; mark(c); mark(k); }
      break;
    }
  }
}

// ---------- run ----------
const out = (yr: number) => {
  const dir = `${dstPrefix}${yr}/${name}`; mkdirSync(dir, { recursive: true });
  const h = Int32Array.from(h0); let flipped = 0, toLand = 0, toSea = 0;
  for (let k = 0; k < N; k++) {
    const was = h0[k] > 0, now = F[k] > 0.5;
    if (was !== now) {
      const v = Math.round((F[k] - 0.5) * SLOPE * CELL * 256);
      h[k] = now ? Math.max(1, v) : Math.min(-1, v); flipped++; if (now) toLand++; else toSea++;
    }
  }
  writeFileSync(`${dir}/state.i32`, new Uint8Array(h.buffer));
  if (!existsSync(`${dstPrefix}${yr}/${name}-t4`) && existsSync(`${srcDir}/${name}-t4`)) cpSync(`${srcDir}/${name}-t4`, `${dstPrefix}${yr}/${name}-t4`, { recursive: true });
  return { flipped, toLand, toSea };
};

refreshBoundary(true);
buildChain();
let lowCells = 0, sx = 0, sy = 0, berms: number[] = [];
for (let i = 0; i < nv; i++) if (vmob[i]) { lowCells++; const c = vc[i]; sx += c % S; sy += (c / S) | 0; if (h0[c] > 0) berms.push(h0[c] / 256); }
if (!lowCells) { console.log(`${name}: no low coast`); for (const y of years) out(y); process.exit(0); }
berms.sort((a, b) => a - b);
const berm = Math.min(3, Math.max(0.5, berms.length ? berms[berms.length >> 1] : 1));
const clim = climate(Math.round(sx / lowCells), Math.round(sy / lowCells), berm);
const V = CELL * CELL * clim.D, Emax = Math.max(...clim.dirs.map((d) => d.E)), Qmax = K * Emax * SHAPE_MAX, DT = FRAC * V / Qmax;
// each direction has its own step, the one that moves FRAC of a cell's volume at the greatest flux (at most 2 days); directions are drawn with probability p / dt and the clock runs dt / (share of
// time with any fetch) so that every direction holds its share of the years
const dtOf = clim.dirs.map((d) => (d.E > 0 ? Math.min(2 * 86400, FRAC * V / (K * d.E * SHAPE_MAX)) : 0));
const wts = clim.dirs.map((d, i) => (dtOf[i] > 0 ? d.p / dtOf[i] : 0)), wsum = wts.reduce((a, b) => a + b, 0), pAct = clim.dirs.reduce((t, d, i) => t + (dtOf[i] > 0 ? d.p : 0), 0);
const cum: number[] = []; { let t = 0; for (const w of wts) { t += w / wsum; cum.push(t); } }
const meanQ = clim.dirs.reduce((t, d) => t + d.p * K * d.E * SHAPE_MAX, 0);
console.log(`${name}: chain ${nv} visits in ${loopA.length} loops, low ${lowCells}; site lat ${clim.lat.toFixed(1)} wind ${clim.U.toFixed(1)} m/s toward ${clim.windToward.toFixed(0)} deg; He ${clim.He.toFixed(2)} m Te ${clim.Te.toFixed(1)} s d_c ${clim.dc.toFixed(1)} berm ${berm.toFixed(2)} D ${clim.D.toFixed(1)} m; fetch km ${clim.dirs.filter((_, i) => i % 4 === 0).map((d) => d.fetchKm.toFixed(0)).join(" ")}; Qmax ${Qmax.toFixed(3)} m3/s, dt ${(DT / 86400).toFixed(2)} d`);
const pending = [...years].sort((a, b) => a - b);
const mass0 = (() => { let t = 0; for (let k = 0; k < N; k++) if (mobile[k]) t += F[k]; return t; })();
const t0 = performance.now(); let tsim = 0, nextLog = 0, owDays = 0;
const stats: Record<string, unknown> = { name, site: { lat: clim.lat, lon: clim.lon }, windU: clim.U, He: clim.He, Te: clim.Te, dc: clim.dc, berm, D: clim.D, K, dtDays: DT / 86400, QmaxM3s: Qmax, meanQTotalM3s: meanQ, seed: SEED, runs: [] as unknown[] };
while (pending.length && step < MAXSTEPS) {
  const r = rnd(); let k = 0; while (k < cum.length - 1 && r > cum[k]) k++;
  const d = clim.dirs[k], dt = dtOf[k];
  if (dt > 0) { transport(d.wx, d.wy, K * d.E, dt, V); owDays += dt / 86400; if (step % 4 === 0) { overwash(owDays); owDays = 0; } }
  fixBeach();
  refreshBoundary(false); buildChain();
  step++; tsim += dt / pAct;
  if (step >= nextLog) { nextLog += 20000; console.log(`  step ${step} year ${(tsim / 365.25 / 86400).toFixed(0)} chain ${nv} loops ${loopA.length} ${((performance.now() - t0) / 1000).toFixed(0)} s`); }
  while (pending.length && tsim >= pending[0] * 365.25 * 86400) {
    const yr = pending.shift()!; let m = 0; for (let c = 0; c < N; c++) if (mobile[c]) m += F[c];
    const o = out(yr); (stats.runs as unknown[]).push({ years: yr, steps: step, ...o, massChangeCells: m - mass0, lostCells: lost, seconds: (performance.now() - t0) / 1000, chainVisits: nv });
    writeFileSync(`${dstPrefix}${yr}/${name}.shore.json`, JSON.stringify(stats, null, 1));
    console.log(`${name}: wrote year ${yr} after ${step} steps, ${o.flipped} cells flipped (${o.toLand} to land, ${o.toSea} to sea), mass change ${(m - mass0).toFixed(2)} cells, lost ${lost.toFixed(2)}`);
  }
}
