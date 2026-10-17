// The island's fish and the water they live in (docs/research/animal-constants.md sec. 13). Every fish is one object on
// the GPU (src/gpu/fish.ts, its law src/gpu/wgsl/fish.ts); this module lays out the water the law reads, states the
// law's constants with their sources, lays the island's first fish, and is the CPU's side of them: the fish people
// see are views of their objects, and what a basket or a line brings up is one of them, out of the water it was
// dipped in.
//
// The water is the island's 75 m cells: the coastal sea down to 10 m (the deeper sea holds none here), each lake, and
// every stream, each cell of a stream draining to the next down its line and the last into the sea or
// the lake it runs to. A body of water is every cell joined to another by water, side to side or down a stream, so a
// lake whose stream runs to the sea is one body with it; fish move only within their own body.
import { TILE_M, groundOf, heldStore, iceAt, wetAt, type Agent, type Animal, type World } from "./world";
import { DAY, YEAR_DAYS, onDay, seasonAt } from "./sky";
import { quickNow, streamNow } from "./streams";
import { flowNow, widthOf } from "../terrain/water";
import { SIZE, waterAt } from "../terrain/flora";
import { CELL, N } from "../terrain/grid";
import { FISH, FISH_LAY, Fish, type FishDriver } from "../gpu/fish";
import { BODIES, CT_, CT_RUNS, FS, G, GK, K, KIND, KW, NFS, NONE, PO, SUB, TILE_MM, FLAG } from "../gpu/wgsl/fish";
import { CELLS } from "../gpu/wgsl/index";
import type { Obj } from "../gpu/mirror";

// ---------- the law's constants (sec. 13) ----------
const YEARS_PACE = 365.25 / YEAR_DAYS; // real days of a fish's life in an island day, as the animals' (animals.ts)
const q16 = (x: number) => Math.round(x * 65536);
// By water: sea, lake, stream (KIND 1 to 3).
type ByWater = [sea: number, lake: number, stream: number];
type Kind = {
  a: number; b: number; // W = a L^b, g from cm (FishBase's Bayesian length-weight)
  linf: ByWater; k: ByWater; // von Bertalanffy L-infinity, cm, and K a year, by water
  lmat: number; // cm, FishBase's length at first maturity
  eggs: number; // eggs a g of female a year
  egg: number; // g, an egg's weight
  rec: number; // cm, the young's length when they are first counted, on the recruits' day of their second year
  months: number; // from spawning to that recruits' day, years
  smolt: number; // cm, a trout's length to go to sea in spring (0 for none)
  moves: ByWater; // steps of a cell a day by water
  home: number; // the kinds of water it lives in (bit KIND)
  nurse: 0 | 1; // its young laid in its body's nearest stream
};
const SEA = 1 << KIND.sea, LAKE = 1 << KIND.lake, STREAM_W = 1 << KIND.stream;
// Brown trout, sea-run where its stream reaches the sea (R851): growth in a Danish brook, the middle of FishBase's six
// for Brandstrup Brook, 30.5 cm and 0.21 (R855); at sea the Gudenaa's Baltic sea trout, 88.6 cm and 0.388 (R855); in
// a lake the Lar dam's 45 cm and 0.27 (R416). Lm 20.6 cm and W = 0.00871 L^3.03 (R854). Baltic sea trout carry 2,527
// to 2,652 eggs a kg, 75 mg each (R853), spawning from November into January (R851), so about 1.8 years before the
// recruits' day of their second year [derived]; smolts go down to the sea from spring to early summer at 12 to 25 cm
// (R861), here at the floor. Its young are 12 cm by their second October [gap]. In a stream it stays near home
// [design: one step a day]; at sea and in lakes a sea trout's month ranges over 0.43 km2 (R426), so about (656 m / 75
// m)^2 / 3.3 steps of a cell in an island day [derived].
// The three-spined stickleback is not among them: at the food these waters make it would number tens of millions,
// past any room for individuals [gap].
// Perch: at sea Fjardsundet's (Aland, the Baltic coast) females, 26.4 cm and 0.197; in lakes FishBase's 25 German
// lakes, 29.3 cm and 0.354; Lm 16.3 cm, W = 0.00912 L^3.11; Schleswig-Holstein's 80 to 100 eggs a g (R857); eggs of
// 2.2 mm, spawning in April and May, 11 cm by their second October [gap].
// Roach: Lake Pyhajarvi's 36.3 cm and 0.081, Lm 14 cm, W = 0.00741 L^3.16, Lake Volvi's mean 187 eggs a g (R858);
// eggs of 1.4 mm, spawning in May, 8 cm by their second October [gap].
// Pike: Lake Peipus's females, 97.5 cm and 0.208, Lm 39.9 cm, W = 0.00447 L^3.08, Schleswig-Holstein's 40 to 50 eggs
// a g (R859); eggs of 2.7 mm, spawning March and April, 30 cm by their second October [gap].
// The young are objects only from their second autumn: the year and a half from egg to there is evaluated for each
// mother's eggs on the recruits' day, its survivors laid then [design: the young of the year would outnumber the room].
// Eel: on the Mecklenburg-Vorpommern coast 77.8 cm and 0.143, in Lake Sacrow 73 cm and 0.078, in Tadnoll Brook 70.8
// cm and 0.064; W = 0.00095 L^3.17; it leaves for the Sargasso Sea to spawn once it is grown, Lm 55 cm (R860). The
// glass eels that come in from the sea are not on the island [gap].
// The perch, roach and pike keep to the lakes and the sea; the eel and the trout live in every water. How far each but
// the trout moves in a day [design].
const sphere = (mm: number) => (Math.PI / 6) * (mm / 10) ** 3; // g, an egg of that diameter at the density of water
const KINDS: Kind[] = [];
const TROUT_RANGE = Math.round((Math.sqrt(0.43e6) / CELL) ** 2 / (30 / YEARS_PACE));
KINDS[FS.trout] = {
  a: 0.00871, b: 3.03, linf: [88.6, 45, 30.5], k: [0.388, 0.27, 0.21], lmat: 20.6, eggs: (2.527 + 2.652) / 2, egg: 0.075, rec: 12, months: 1.8,
  smolt: 12, moves: [TROUT_RANGE, TROUT_RANGE, 1], home: SEA | LAKE | STREAM_W, nurse: 1,
};
KINDS[FS.perch] = {
  a: 0.00912, b: 3.11, linf: [26.4, 29.3, 29.3], k: [0.197, 0.354, 0.354], lmat: 16.3, eggs: 90, egg: sphere(2.2), rec: 11, months: 1.4,
  smolt: 0, moves: [4, 4, 0], home: SEA | LAKE, nurse: 0,
};
KINDS[FS.roach] = {
  a: 0.00741, b: 3.16, linf: [36.3, 36.3, 36.3], k: [0.081, 0.081, 0.081], lmat: 14, eggs: 187, egg: sphere(1.4), rec: 8, months: 1.38,
  smolt: 0, moves: [4, 4, 0], home: SEA | LAKE, nurse: 0,
};
KINDS[FS.pike] = {
  a: 0.00447, b: 3.08, linf: [97.5, 97.5, 97.5], k: [0.208, 0.208, 0.208], lmat: 39.9, eggs: 45, egg: sphere(2.7), rec: 30, months: 1.5,
  smolt: 0, moves: [2, 2, 0], home: SEA | LAKE, nurse: 0,
};
KINDS[FS.eel] = {
  a: 0.00095, b: 3.17, linf: [77.8, 73, 70.8], k: [0.143, 0.078, 0.064], lmat: 55, eggs: 0, egg: 1, rec: 15, months: 1,
  smolt: 0, moves: [1, 1, 1], home: SEA | LAKE | STREAM_W, nurse: 0,
};
// Lorenzen's natural mortality of juvenile and adult fish, M = Mu W^b a year at W g: the ocean's 3.69 and -0.305, lakes'
// 3.37 and -0.291, rivers' 2.53 and -0.289 (R850). It counts all of a stock's natural deaths, predators' too.
const MU: ByWater = [3.69, 3.37, 2.53], MB: ByWater = [-0.305, -0.291, -0.289];
const mass = (f: Kind, cm: number) => f.a * cm ** f.b;
// The young's survival from egg to recruit at a full share of food: e^-I, I Lorenzen's M summed along a weight growing
// evenly in its logarithm from the egg to the recruit over the months between [derived]. Lorenzen's data held no eggs
// or larvae (R850), so this carries his law below its range [gap].
function juv(f: Kind, k: number) {
  const w0 = f.egg, w1 = mass(f, f.rec), g = Math.log(w1 / w0) / f.months;
  return (MU[k] * (w1 ** MB[k] - w0 ** MB[k])) / (MB[k] * g);
}
// The most cells a fish swims down a stream in an island day [design].
const RUN = 64;
// The young of the year are counted on 1 October [design]; smolts go down in April and May (R861).
const RECRUIT_DAY = onDay(195), SMOLT_FROM = onDay(12), SMOLT_TO = onDay(72);
export function fishConsts(): Uint32Array {
  const KP = new Uint32Array(PO);
  KINDS.forEach((f, s) => {
    const at = s * KW;
    KP[at + K.lna] = q16(Math.log(f.a)) >>> 0;
    KP[at + K.b] = q16(f.b);
    for (let k = 0; k < 3; k++) {
      KP[at + K.linf + k] = Math.round(f.linf[k] * 1e4);
      KP[at + K.keep + k] = q16(Math.exp(-f.k[k] / YEAR_DAYS));
      KP[at + K.juv + k] = q16(juv(f, k));
      KP[at + K.moves + k] = f.moves[k];
    }
    KP[at + K.lmat] = Math.round(f.lmat * 1e4);
    KP[at + K.eggs] = q16(f.eggs);
    KP[at + K.lrec] = Math.round(f.rec * 1e4);
    KP[at + K.smolt] = Math.round(f.smolt * 1e4);
    KP[at + K.home] = f.home;
    KP[at + K.nurse] = f.nurse;
  });
  for (let k = 0; k < 3; k++) { KP[GK + G.mu + k] = q16(MU[k]); KP[GK + G.mb + k] = q16(MB[k]) >>> 0; }
  KP[GK + G.pace] = q16(1 / YEAR_DAYS);
  KP[GK + G.run] = RUN;
  KP[GK + G.days] = YEAR_DAYS;
  KP[GK + G.year] = YEAR_DAYS * DAY;
  KP[GK + G.oldest] = OLDEST;
  return KP;
}

// ---------- the water ----------
// What the water makes, mg of carbon a m2 a day: oligotrophic lakes 50 to 100, eutrophic 600 to 8,000 (R419), between
// their middles (75 and the eutrophic's geometric middle, 2,190) by the fertility of the land within a kilometre
// [derived]; of that the fish get two steps of the food chain's 10% each (R420), as wet fish at 12.5% carbon (R421): g
// of fish a m2 a day. A stream's: the mean of the production of trout in two Danish brooks, 15.9 and 6.9 g a m2 a year
// (R851), taken as what its food holds [derived].
const PP_POOR = 75, PP_RICH = Math.sqrt(600 * 8000), CHAIN = 0.1 * 0.1, FISH_C = 0.125, BROOK = (15.9 + 6.9) / 2 / 365.25;
// The sea's fish live in its coastal water, down to 10 to 20 m deep (Kraufvelin et al., R862), here its floor; the
// deeper sea holds none here [derived]. The land within a kilometre feeds the water [derived, as before].
const SHALLOW = 10, INSHORE = Math.floor(1000 / CELL);
type Seg = { len: number; q: number; base: number; qbf: number; wbf: number; under: number };
export type Waters = {
  kind: Uint8Array; body: Int32Array; bodies: number; down: Int32Array; nurse: Int32Array; m0: Uint32Array; m1: Uint32Array;
  area: Float32Array; // m2 of water at the mean (sea and lakes: all the year)
  rate: Float32Array; // g of fish a m2 a day the water feeds at the year's mean light
  segs: Map<number, Seg[]>; // a stream cell's stretches of stream
  light: Float32Array; // each island day's light over the water against its year's mean
};
const watersBySeed = new Map<number, Waters>();
const cellOf = (x: number, z: number) => Math.min(N - 1, Math.max(0, Math.floor((z + SIZE / 2) / CELL))) * N + Math.min(N - 1, Math.max(0, Math.floor((x + SIZE / 2) / CELL)));
export function watersOf(seed: number): Waters {
  let v = watersBySeed.get(seed);
  if (v) return v;
  const { isle, fine } = groundOf(seed);
  const wet = (k: number) => isle.water[k] > 0;
  // the sea: water joined to the map's edge; the rest of the standing water is lakes
  const kind = new Uint8Array(CELLS), seen = new Uint8Array(CELLS), todo: number[] = [];
  for (let k = 0; k < CELLS; k++) { const x = k % N, y = Math.floor(k / N); if ((x === 0 || y === 0 || x === N - 1 || y === N - 1) && wet(k)) { seen[k] = 1; todo.push(k); } }
  for (let i = 0; i < todo.length; i++) {
    const k = todo[i], x = k % N, y = Math.floor(k / N);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy, n = ny * N + nx;
      if (nx >= 0 && ny >= 0 && nx < N && ny < N && !seen[n] && wet(n)) { seen[n] = 1; todo.push(n); }
    }
  }
  // land within a kilometre, and its fertility, by summed-area tables
  const S = (N + 1) * (N + 1), sl = new Float64Array(S), sf = new Float64Array(S);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const k = y * N + x, o = (y + 1) * (N + 1) + x + 1, land = wet(k) ? 0 : 1;
    sl[o] = land + sl[o - 1] + sl[o - N - 1] - sl[o - N - 2];
    sf[o] = land * isle.fertility[k] + sf[o - 1] + sf[o - N - 1] - sf[o - N - 2];
  }
  const box = (t: Float64Array, k: number) => {
    const x = k % N, y = Math.floor(k / N), x0 = Math.max(0, x - INSHORE), y0 = Math.max(0, y - INSHORE), x1 = Math.min(N, x + INSHORE + 1), y1 = Math.min(N, y + INSHORE + 1);
    return t[y1 * (N + 1) + x1] - t[y0 * (N + 1) + x1] - t[y1 * (N + 1) + x0] + t[y0 * (N + 1) + x0];
  };
  const area = new Float32Array(CELLS), rate = new Float32Array(CELLS), m0 = new Uint32Array(CELLS), m1 = new Uint32Array(CELLS);
  const sub = (k: number, sq: number) => { if (sq < 32) m0[k] |= 1 << sq; else m1[k] |= 1 << (sq - 32); };
  for (let k = 0; k < CELLS; k++) {
    if (!wet(k)) continue;
    const near = box(sl, k);
    if (seen[k] && (near === 0 || -isle.height[k] > SHALLOW)) continue;
    kind[k] = seen[k] ? KIND.sea : KIND.lake;
    const fed = near > 0 ? Math.max(0, Math.min(1, box(sf, k) / near)) : 0;
    rate[k] = ((PP_POOR * (PP_RICH / PP_POOR) ** fed) / 1000) * (CHAIN / FISH_C);
    // the squares under water: all of them where every cell round is water, else as the map draws the shore
    const x = k % N, y = Math.floor(k / N);
    let inner = true;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const nx = x + dx, ny = y + dy; if (nx >= 0 && ny >= 0 && nx < N && ny < N && !wet(ny * N + nx)) inner = false; }
    for (let sq = 0; sq < SUB * SUB; sq++) {
      const wx = -SIZE / 2 + x * CELL + ((sq % SUB) + 0.5) * (CELL / SUB), wz = -SIZE / 2 + y * CELL + (Math.floor(sq / SUB) + 0.5) * (CELL / SUB);
      if (inner || waterAt(isle, fine, wx, wz) > 0.5) sub(k, sq);
    }
    area[k] = (CELL * CELL * (popcount(m0[k]) + popcount(m1[k]))) / (SUB * SUB);
  }
  // the streams: each stretch filed by the cell its middle lies in, where no lake or sea covers it
  const segs = new Map<number, Seg[]>(), down = new Int32Array(CELLS).fill(-1), downQ = new Float32Array(CELLS);
  for (const line of fine.rivers) {
    let prev = -1;
    for (let j = 1; j < line.length; j++) {
      const p = line[j - 1], r = line[j], mx = (p[0] + r[0]) / 2, mz = (p[1] + r[1]) / 2, k = cellOf(mx, mz), q = (p[2] + r[2]) / 2;
      if (prev >= 0 && prev !== k && kind[prev] === KIND.stream && (down[prev] < 0 || q > downQ[prev])) { down[prev] = k; downQ[prev] = q; }
      prev = k;
      if (kind[k] === KIND.sea || kind[k] === KIND.lake) continue;
      kind[k] = KIND.stream;
      const s: Seg = { len: Math.hypot(r[0] - p[0], r[1] - p[1]), q, base: (p[3] + r[3]) / 2, qbf: (p[4] + r[4]) / 2, wbf: (p[7] + r[7]) / 2, under: (p[6] + r[6]) / 2 };
      const list = segs.get(k);
      if (list) list.push(s); else segs.set(k, [s]);
      for (const [px, pz] of [[mx, mz], [r[0], r[1]]]) if (cellOf(px, pz) === k) sub(k, Math.min(SUB - 1, Math.floor((((pz + SIZE / 2) % CELL) / CELL) * SUB)) * SUB + Math.min(SUB - 1, Math.floor((((px + SIZE / 2) % CELL) / CELL) * SUB)));
    }
    // a stream's last cell runs into the water beside it, if any [design]
    if (prev >= 0 && kind[prev] === KIND.stream && down[prev] < 0) {
      const x = prev % N, y = Math.floor(prev / N);
      for (let dy = -1; dy <= 1 && down[prev] < 0; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy, n = ny * N + nx;
        if (nx >= 0 && ny >= 0 && nx < N && ny < N && (kind[n] === KIND.sea || kind[n] === KIND.lake)) { down[prev] = n; break; }
      }
    }
  }
  for (const [k, list] of segs) {
    rate[k] = BROOK;
    area[k] = list.reduce((s, g) => s + g.len * widthOf(g.q, g.qbf, g.wbf), 0);
  }
  // the bodies of water: standing water side to side, and each stream cell to the cell it drains to
  const root = Int32Array.from({ length: CELLS }, (_, i) => i);
  const find = (i: number): number => { while (root[i] !== i) { root[i] = root[root[i]]; i = root[i]; } return i; };
  const join = (a: number, b: number) => { const ra = find(a), rb = find(b); if (ra !== rb) root[Math.max(ra, rb)] = Math.min(ra, rb); };
  for (let k = 0; k < CELLS; k++) {
    if (!kind[k]) continue;
    if (kind[k] === KIND.stream) { if (down[k] >= 0 && kind[down[k]]) join(k, down[k]); continue; }
    const x = k % N, y = Math.floor(k / N);
    if (x + 1 < N && kind[k + 1] === kind[k]) join(k, k + 1);
    if (y + 1 < N && kind[k + N] === kind[k]) join(k, k + N);
  }
  const body = new Int32Array(CELLS).fill(-1), ids = new Map<number, number>();
  for (let k = 0; k < CELLS; k++) if (kind[k]) { const r = find(k); if (!ids.has(r)) ids.set(r, ids.size); body[k] = ids.get(r)!; }
  // the nearest stream cell of the same body to every cell of it, a step at a time across the body's cells
  const nurse = new Int32Array(CELLS).fill(-1), front: number[] = [];
  for (const k of segs.keys()) { nurse[k] = k; front.push(k); }
  front.sort((a, b) => a - b);
  for (let i = 0; i < front.length; i++) {
    const k = front[i], x = k % N, y = Math.floor(k / N);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy, n = ny * N + nx;
      if (nx >= 0 && ny >= 0 && nx < N && ny < N && kind[n] && body[n] === body[k] && nurse[n] < 0) { nurse[n] = nurse[k]; front.push(n); }
    }
    if (down[k] >= 0 && kind[down[k]] && nurse[down[k]] < 0) { nurse[down[k]] = nurse[k]; front.push(down[k]); }
  }
  // the light over the water each island day against its year's mean, as the seasons' sun runs between their middles
  const sunBy = isle.seasons.map((s) => { let t = 0, n = 0; for (let k = 0; k < CELLS; k++) if (kind[k]) { t += s.sun[k]; n++; } return n ? t / n : 0; });
  const mean = sunBy.reduce((a, b) => a + b, 0) / sunBy.length, light = new Float32Array(YEAR_DAYS);
  for (let d = 0; d < YEAR_DAYS; d++) { const { s, f } = seasonAt(d * DAY + DAY / 2); light[d] = mean > 0 ? (sunBy[s] * (1 - f) + sunBy[(s + 1) % 4] * f) / mean : 1; }
  v = { kind, body, bodies: ids.size, down, nurse, m0, m1, area, rate, segs, light };
  watersBySeed.set(seed, v);
  return v;
}
function popcount(x: number) { let n = 0; for (let v = x >>> 0; v; v &= v - 1) n++; return n; }

// The quick share of the streams' flow at tick t: the weather's, once the world has it (streams.ts), else the season's.
function quickAt(w: World, t: number) {
  if (t >= w.t) return quickNow(w);
  const { s, f } = seasonAt(t), q = groundOf(w.seed).isle.quick;
  return q[s] * (1 - f) + q[(s + 1) % 4] * f;
}
// Each cell's water now, m2: a stream's stretches still running at their width now (streams.ts), dry ones none.
function areaNow(v: Waters, k: number, quick: number) {
  const list = v.segs.get(k);
  if (!list) return v.area[k];
  let a = 0;
  for (const g of list) { const q = flowNow(g.q, g.base, quick); if (q > g.under) a += g.len * widthOf(q, g.qbf, g.wbf); }
  return a;
}
const dayOf = (t: number) => ((t / DAY) % YEAR_DAYS + YEAR_DAYS) % YEAR_DAYS;
const crossed = (from: number, to: number, at: number) => (from <= to ? from < at && at <= to : from < at || at <= to);

// ---------- the fish on the GPU ----------
const hosts = new WeakMap<World, Fish>();
export const fishOf = (w: World) => { let f = hosts.get(w); if (!f) hosts.set(w, (f = new Fish())); return f; };
// The island days run before anyone wakes, for the fish to settle from where they are laid, as the animals' ten
// (animals.ts) [design].
const SPIN_DAYS = 10;
export function fishDriver(w: World): FishDriver {
  const v = watersOf(w.seed), food = new Uint32Array(CELLS);
  return {
    seed: w.seed, days: SPIN_DAYS, t0: w.t,
    cells: () => {
      const out = new Uint32Array(CT_RUNS * CELLS);
      for (let k = 0; k < CELLS; k++) {
        out[CT_.kb * CELLS + k] = v.kind[k] ? v.kind[k] | (Math.min(v.body[k], BODIES - 1) << 2) : 0;
        out[CT_.down * CELLS + k] = v.down[k] >= 0 ? v.down[k] : NONE;
        out[CT_.nurse * CELLS + k] = v.nurse[k] >= 0 ? v.nurse[k] : NONE;
        out[CT_.m0 * CELLS + k] = v.m0[k]; out[CT_.m1 * CELLS + k] = v.m1[k];
      }
      return out;
    },
    consts: fishConsts,
    start: () => startFish(v),
    step(t) {
      const now = dayOf(t), quick = quickAt(w, t), light = v.light[Math.floor(now)];
      for (let k = 0; k < CELLS; k++) {
        if (!v.kind[k]) { food[k] = 0; continue; }
        const a = areaNow(v, k, quick);
        food[k] = a > 0 ? Math.max(1, Math.round(a * v.rate[k] * light * YEARS_PACE * 100)) : 0;
      }
      const flags = (crossed(dayOf(t - DAY), now, RECRUIT_DAY) ? FLAG.recruit : 0) | (now >= SMOLT_FROM && now < SMOLT_TO ? FLAG.smolt : 0);
      return { flags, food };
    },
  };
}
// The island's first fish [design]: in each cell of water, each kind its share of what the water feeds over a year
// over Lorenzen's mortality at its weight at maturity, so about the stock its water would carry, in fish at the mean
// weight of the ages laid, all of it thinned evenly where that many would pass FISH_LAY
// (src/gpu/fish.ts); the GPU lays each (wgsl/fish.ts START_INIT) in its second year or older, one more year with a
// chance of a half, at its kind's length for that age in that water.
const START_SHARE: Record<number, number[]> = {
  [KIND.sea]: [0.4, 0.3, 0.15, 0.075, 0.075],
  [KIND.lake]: [0.1, 0.35, 0.3, 0.15, 0.1],
  [KIND.stream]: [0.85, 0, 0, 0, 0.15],
};
const OLDEST = 12;
function startFish(v: Waters) {
  const want = new Float64Array(CELLS * NFS), each: number[][] = [];
  for (let s = 0; s < NFS; s++) {
    const f = KINDS[s];
    each[s] = [1, 2, 3].map((kd) => {
      let m = 0, li = f.linf[kd - 1];
      for (let age = 1; age <= OLDEST; age++) m += (age < OLDEST ? 0.5 ** age : 0.5 ** (OLDEST - 1)) * mass(f, li - (li - Math.min(f.rec, li)) * Math.exp(-f.k[kd - 1] * (age - 1)));
      return m;
    });
  }
  let fish = 0;
  for (let k = 0; k < CELLS; k++) {
    const kd = v.kind[k];
    if (!kd || v.area[k] <= 0) continue;
    for (let s = 0; s < NFS; s++) {
      const f = KINDS[s], share = START_SHARE[kd][s];
      if (!share || !((f.home >> kd) & 1)) continue;
      const g = (v.area[k] * v.rate[k] * 365.25 * share) / (MU[kd - 1] * mass(f, f.lmat) ** MB[kd - 1]);
      want[k * NFS + s] = g / each[s][kd - 1];
      fish += want[k * NFS + s];
    }
  }
  const thin = Math.min(1, FISH_LAY / fish);
  return Uint32Array.from(want, (n) => Math.round(n * thin));
}

// ---------- the fish people see and catch ----------
// The cell of water someone dips into from where they stand: the first of the points a couple of paces round them
// (physics.ts openWater) that is open water of a cell the fish live in; -1 for none.
function dipCell(w: World, at: { px: number; py: number }) {
  const v = watersOf(w.seed);
  for (let k = -1; k < 8; k++) {
    const r = k < 0 ? 0 : 3 / TILE_M, x = at.px + Math.cos((k * Math.PI) / 4) * r, y = at.py + Math.sin((k * Math.PI) / 4) * r;
    const c = Math.min(N - 1, Math.max(0, Math.floor((y * TILE_M) / CELL))) * N + Math.min(N - 1, Math.max(0, Math.floor((x * TILE_M) / CELL)));
    if (!v.kind[c]) continue;
    if ((wetAt(w, x, y) && !iceAt(w, Math.floor(x), Math.floor(y))) || streamNow(w, x, y)?.flowing) return c;
  }
  return -1;
}
// The body of water dipped into there; -1 for none.
export function waterHere(w: World, at: { px: number; py: number }) {
  const c = dipCell(w, at);
  return c < 0 ? -1 : watersOf(w.seed).body[c];
}
// The fish of one body of water within m metres of a place, nearest first, as the landings round people hold them.
function fishWithin(w: World, at: { px: number; py: number }, m: number, body: number): Obj[] {
  const s = heldStore(w);
  if (!s || body < 0 || !s.kinds.some((k) => k.name === FISH)) return [];
  const v = watersOf(w.seed), r = m / TILE_M, near: [Obj, number][] = [];
  const x0 = Math.floor(((at.px - r) * TILE_M) / CELL), x1 = Math.floor(((at.px + r) * TILE_M) / CELL);
  const y0 = Math.floor(((at.py - r) * TILE_M) / CELL), y1 = Math.floor(((at.py + r) * TILE_M) / CELL);
  for (let cy = Math.max(0, y0); cy <= Math.min(N - 1, y1); cy++) for (let cx = Math.max(0, x0); cx <= Math.min(N - 1, x1); cx++) {
    if (v.body[cy * N + cx] !== body) continue;
    const objs = s.mirror.landed(FISH, cx, cy);
    if (!Array.isArray(objs)) continue;
    for (const o of objs) { const d = Math.hypot(o.v.x / TILE_MM - at.px, o.v.y / TILE_MM - at.py); if (d <= r) near.push([o, d]); }
  }
  return near.sort((a, b) => a[1] - b[1] || a[0].id - b[0].id).map(([o]) => o);
}
// What a gear dipped there can meet (people-constants sec. 9.9): the fish of the cell of water it is dipped in, which
// range over that cell's water in a day (the GPU moves them once a day), each with its length, cm, and the cell's
// water now, m2.
export function meeting(w: World, at: { px: number; py: number }): { fish: { id: number; cm: number }[]; area: number } {
  const s = heldStore(w), c = dipCell(w, at);
  if (!s || c < 0 || !s.kinds.some((k) => k.name === FISH)) return { fish: [], area: 0 };
  const objs = s.mirror.landed(FISH, c % N, Math.floor(c / N));
  const fish = Array.isArray(objs) ? objs.map((o) => ({ id: o.id, cm: o.v.len / 1e4 })).sort((a, b) => a.id - b.id) : [];
  return { fish, area: areaNow(watersOf(w.seed), c, quickAt(w, w.t)) };
}
// Fish lifted out of the water: their objects die and their views go.
export function takeFish(w: World, ids: number[]) {
  const s = heldStore(w);
  if (!s || !ids.length) return;
  for (const id of ids) s.kill(id);
  const out = new Set(ids);
  w.animals = w.animals.filter((an) => an.obj === undefined || !out.has(an.obj));
}
// A fish's weight, kg, as its object has it (its kind's length-weight, sec. 13); none for one no longer there.
export function fishKg(w: World, an: Animal) {
  const o = an.obj === undefined ? null : heldStore(w)?.mirror.get(an.obj);
  if (!o || typeof o !== "object") return 0;
  return mass(KINDS[o.v.sp & 15], o.v.len / 1e4) / 1000;
}
// The fish people see stand in the shallows within a basket's sweep of them [design]: views of
// their objects (an id of the object's, so one seen again is the same fish), gone once no one sees them or their
// object is gone; spawn: how one is put down.
const SHALLOWS = 15;
export function showFish(w: World, spawn: (px: number, py: number, id: number) => Animal) {
  const s = heldStore(w);
  if (!s || !s.kinds.some((k) => k.name === FISH)) return;
  const awake = w.agents.filter((a: Agent) => a.down <= w.t), seen = new Set<number>(), have = new Map<number, Animal>();
  for (const an of w.animals) if (an.species === "fish" && an.obj !== undefined) have.set(an.obj, an);
  for (const a of awake) {
    const body = waterHere(w, a);
    for (const o of fishWithin(w, a, SHALLOWS, body)) {
      seen.add(o.id);
      const an = have.get(o.id);
      if (an) { an.px = o.v.x / TILE_MM; an.py = o.v.y / TILE_MM; an.x = Math.floor(an.px); an.y = Math.floor(an.py); }
      else have.set(o.id, spawn(o.v.x / TILE_MM, o.v.y / TILE_MM, o.id));
    }
  }
  const gone = w.animals.filter((an) => an.species === "fish" && (an.obj === undefined || !seen.has(an.obj)));
  if (gone.length) { const out = new Set(gone); w.animals = w.animals.filter((an) => !out.has(an)); }
}
// How many fish live in the island's water, as the last law counted them.
export function fishCount(w: World) {
  const c = fishOf(w).census;
  let n = 0;
  for (let s = 0; s < NFS; s++) n += c[s];
  return n;
}
