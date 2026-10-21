// The rest of the island's climate on the GPU (kernels: wgsl/terrain-climate.ts): the wind and the salt, the horizons and
// the sky left open, the sun through the cloud, warmth, damp air and the pool of cold air, the snow years, and Penman's
// evaporation. The inputs are the heights, open water and the prevailing wind's angle, with the rain of each season
// beside them (rainGpu's output); the outputs are the Climate's fields in its units. A patch of the planet
// (gpu/globe/air.ts) runs the same kernels in a wider format, with the place's numbers per cell (PatchInput).
//
// Fixed point (Qn: a value x held as round(x * 2^n)); the arena's sections and their scales are in SECTIONS of the
// kernels' file. Converted at these edges only: inputs and the tables' constants are rounded once on the host, and
// everything between a buffer's read and its write is integer.
//
// What is random in the stage: the prevailing wind's angle (an input here), and the snow years' weather, a mulberry
// sequence seeded 0x5eed that is the same for every island, so it is a table of 4,015 days, not a draw.
import { CELL, LEN, N } from "../../terrain/grid";
import {
  DAY_KEEPS, DAY_SPREAD, DIRS, FOG, FOG_Z, IN_CLOUD, POOL_C, ROSE, SEASONS, SEASON_DAYS, SNOW_HALF, SNOW_SPREAD, STEP,
  codeRose, esat, meanWay, midSeason, mulberry, turned,
} from "../../terrain/climate";
import { skyAt } from "../../sim/sky";
import type { Gpu } from "../device";
import { cover, pipeline, readback, storage } from "../kernel";
import {
  BANDS_MAX, COVERS_N, DAYS, ISLAND_CLIMATE, LOGIT_N, REACH_N, SAT_N, SEAS, airWgsl, layoutOf, petWgsl, prepWgsl, shapeWgsl, snowWgsl, sunWgsl, warmWgsl,
  type ClimateFormat, type Layout,
} from "../wgsl/terrain-climate";

const NS = SEASONS.length;
// Most the words hold: a height or a depth in m (Q16 in an i32), and a cell's year of rain in mm (the snow years sum it,
// as Q16 a day, over ten years in 32 bits).
const MOST_HEIGHT_M = 32000, MOST_RAIN_MM = 3000;

// What the stage takes of a place: each season's air at sea level (t), the sea's warmth (sea), the air's water against
// saturation (humid0) and the sun's beam and the sky's glow through the season's cloud against a clear sky's; the latitude
// the sun is reckoned at (degrees north); the wind rose's shape (shares from north clockwise), which the prevailing wind's
// angle turns; and how many bits the snow years' sums of rain are shifted down by, so that a wetter place than the island
// fits their words. The island's are Bornholm's (terrain/climate.ts SEASONS, ROSE; sky.ts's 55.1 degrees).
export type ClimatePlace = {
  seasons: readonly { t: number; sea: number; humid0: number; beam: number; glow: number }[];
  latDeg: number; rose: readonly number[]; snowShift: number;
  turn?: number; // the bearing of the ground's y axis from true north, toward the east, radians (sky.ts skyAt); 0 where absent
};
export const ISLAND_PLACE: ClimatePlace = { seasons: SEASONS, latDeg: 55.1, rose: ROSE, snowShift: 0 };

// What a patch of the planet gives the kernels for each cell, in place of a place's one value (format {n, patch: true}; every
// array in the patch's cell order, n x n). The words are the arena's input sections (wgsl/terrain-climate.ts sectionsOf).
export type PatchInput = {
  tS: Int32Array[]; seaS: Int32Array[]; e0S: Int32Array[]; // by season, Q16: the air's sea-level warmth, the sea's, the air's water at sea level
  wturn: Int32Array; // Q16 bearings, mod 16: the cell's wind direction less the rose's own mean, in the patch's axes
  band: Int32Array; // the cell's band of latitude, an index into bandsDeg
  bandsDeg: number[]; // the latitude each band's sun table is made for
  gm: Int32Array; // 4 words a cell, Q16: the lattice's differences to (east, north) gradients, in units of a cell's width (the inverse transpose of the lattice's steps in metres times CELL)
  dsea: Int32Array; // Q12 m: the distance over land to the sea (a global field of the planet)
  groups: Int32Array; // the snow years' groups of four cells, four indices each (-1: none)
  rose: readonly number[]; // the wind rose as measured, shares in the patch's bearings (patchRose)
};
// A measured rose in the bearings of a patch's axes: those run counterclockwise seen from outside (x east, y north), where the island's run toward south, so the
// measured rose is read the other way round and keeps the sense it was measured in [design: the northern hemisphere's, at every latitude: gap].
export const patchRose = (fromNorth: readonly number[]) => {
  const code = codeRose(fromNorth as number[]), sum = code.reduce((s, v) => s + v, 0);
  return code.map((_, k) => code[(DIRS - k) % DIRS] / sum);
};
// The angle the rose's mean turns by in the patch's bearings, radians counterclockwise: the island's `meanWay` in the other sense.
export const patchMeanWay = (fromNorth: readonly number[]) => -meanWay(fromNorth as number[]);

export type ClimateRestInput = {
  // the ground as the generator's height field has it (the sea's depth negative), N x N
  height: Float32Array;
  // 1 over the sea and lakes
  open: Uint8Array;
  // each season's rain in mm over the season, N x N (rainGpu's)
  precip: Float32Array[];
  // the way the prevailing wind blows, in radians: the generator's one random draw for the climate, times 2 pi
  angle: number;
  place?: ClimatePlace;
  patch?: PatchInput;
};
export type ClimateRest = {
  wind: [number, number];
  seasons: { pet: Float32Array; sun: Float32Array; temp: Float32Array; humid: Float32Array; snowpack: Float32Array }[];
  snow: Float32Array;
  snowCover: Float32Array;
  fog: Float32Array;
  temp: Float32Array;
  pet: Float32Array;
  sun: Float32Array;
  sky: Float32Array;
  pool: Float32Array;
  breeze: Float32Array;
  lee: Uint8Array;
  windShare: Float32Array;
  salt: Float32Array;
};

// ---------- the tables, island by island the same ----------
// x * 2^n rounded, noting how far the exact value lay from a rounding tie, so that tableMargin can say how much an engine's
// last-place error in Math.exp, cos or tanh could move a word of the tables.
let least = 0.5;
function rq(x: number, n: number) {
  const v = x * 2 ** n;
  least = Math.min(least, Math.abs(Math.abs(v - Math.floor(v)) - 0.5));
  return Math.round(v);
}
const rq16 = (x: number) => rq(x, 16), rq24 = (x: number) => rq(x, 24);
// The same for a value the model keeps as a float32: the float32 rounding is the step an engine's error could move, and the
// scaled word is then exact in it.
function r32(x: number, n: number) {
  if (x === 0) return 0;
  const s = x / 2 ** (Math.floor(Math.log2(Math.abs(x))) - 23);
  least = Math.min(least, Math.abs(Math.abs(s - Math.floor(s)) - 0.5));
  return Math.round(Math.fround(x) * 2 ** n);
}

// The year's days of weather: each day's standing from its time of year, from a mulberry sequence that is the same for
// every island, before the float32 rounding of the weather it makes.
function anomalies() {
  const out = new Float64Array(DAYS), draw = mulberry(0x5eed);
  let zd = 0;
  for (let d = 0; d < DAYS; d++) {
    const n = Math.sqrt(-2 * Math.log(1 - draw())) * Math.cos(2 * Math.PI * draw());
    zd = DAY_KEEPS * zd + Math.sqrt(1 - DAY_KEEPS * DAY_KEEPS) * n;
    out[d] = DAY_SPREAD[Math.min(3, Math.floor((d % 365) / SEASON_DAYS))] * zd;
  }
  return out;
}

// Season si's middle day through the hours a quarter at a time: the header and one eight-word row for each hour the sun
// stands up, scaled as the kernel reads them (wgsl sunWgsl). The island's rows are in its axes (x east, y south: skyAt's turn
// puts the ground's y axis at its north); a patch's are in the compass's (x east, y north), and the kernel turns the cell's
// normal and horizon to them.
export function sunRows(si: number, beam: number, glow: number, latDeg: number, turn: number, compass: boolean, sunMax: number) {
  const S0 = 1361, DT = 900, { beam: tb, glow: tg } = { beam, glow }, MJ = DT / 1e6, sky = skyAt(latDeg, turn);
  const rows: number[][] = [];
  let sum = 0, levelBeam = 0;
  for (let hour = 0; hour < 24; hour += DT / 3600) {
    const b = sky.sunAt(midSeason(si), hour), sinEl = Math.sin(b.el);
    if (sinEl <= 0.005) continue;
    const am = 1 / (sinEl + 0.50572 * (b.el / (Math.PI / 180) + 6.07995) ** -1.6364), bn = S0 * 0.7 ** (am ** 0.678), cosEl = Math.cos(b.el);
    const dx = b.dir[0], dy = compass ? -b.dir[1] : b.dir[1];
    const kf = (((Math.atan2(dy, dx) / (Math.PI * 2)) * DIRS) % DIRS + DIRS) % DIRS, k0 = Math.floor(kf);
    rows.push([rq16(cosEl * dx), rq16(cosEl * dy), rq16(sinEl), rq24(b.tan), rq24(bn * MJ), k0, rq16(kf - k0), 0]);
    sum += S0 * sinEl * Math.max(0, 0.271 - (0.294 * bn) / S0);
    levelBeam += bn * sinEl;
  }
  if (rows.length > sunMax) throw new Error(`climateRestGpu: ${rows.length} sun samples, room for ${sunMax}`);
  const glowSum = sum, level = levelBeam + glowSum, cloudy = tb * levelBeam + tg * glowSum;
  const head = [rows.length, rq16(tb), rq24(glowSum * MJ), rq24(level * MJ), rq24(cloudy * MJ), rq24(IN_CLOUD * level * MJ), rq24(tg * glowSum * MJ), 0];
  return { head, rows, flat: cloudy * MJ };
}

type Tables = { tab: Int32Array; flatYear: number; coldest: number; warmest: number };
// The words no place changes: the bearings, the horizon's distances, the logistic and saturation curves, the snow years' weather and calendar, the cloud's chances.
function fixedTables(tab: Int32Array, l: Layout) {
  const at = (name: string, i: number, v: number) => { tab[l.TABO[name] + i] = v; };
  const cs = Array.from({ length: DIRS }, (_, k) => [Math.cos((k / DIRS) * Math.PI * 2), Math.sin((k / DIRS) * Math.PI * 2)]);
  cs.forEach(([c, s], k) => {
    at("dirs", 4 * k, rq16(c * STEP)); at("dirs", 4 * k + 1, rq16(s * STEP));
    at("cs16", 2 * k, rq16(c)); at("cs16", 2 * k + 1, rq16(s));
  });
  let reach = 0;
  for (let d = 1; d < 110; d *= 1.2, reach++) { at("reach", 2 * reach, rq16(d)); at("reach", 2 * reach + 1, rq(256 / (d * CELL), 28)); }
  if (reach !== REACH_N) throw new Error(`climateRestGpu: ${reach} horizon distances, the kernel has ${REACH_N}`);
  const days = [0, 0, 0, 0], warm = SNOW_SPREAD.map((s) => SNOW_HALF + 7.6 * s);
  for (let d = 0; d < 365; d++) days[Math.min(3, Math.floor(d / SEASON_DAYS))]++;
  for (let si = 0; si < NS; si++) {
    const row = (n: number) => l.TABO.seas + si * 16 + n;
    tab[row(SEAS.poolc)] = rq24(POOL_C[si]); tab[row(SEAS.warm)] = rq16(warm[si]); tab[row(SEAS.inv)] = rq24(1 / SNOW_SPREAD[si]); tab[row(SEAS.days)] = days[si];
  }
  for (let n = 0; n < LOGIT_N; n++) at("logit", n, rq16(1 / (1 + Math.exp(-40 + n / 100))));
  for (let n = 0; n < SAT_N; n++) at("sat", n, rq16(esat(-40 + n / 100)));
  for (let n = 0; n < COVERS_N; n++) at("covers", n, rq16(0.95 * Math.tanh(n / 1000)));
  let coldest = 0;
  anomalies().forEach((a, d) => { at("anom", d, r32(a, 16)); coldest = Math.min(coldest, Math.fround(a)); });
  for (let d = 0; d < 365; d++) {
    const th = 2 * Math.PI * (d / 365 - 1 / 8);
    at("cal", 4 * d, r32(Math.cos(th), 24)); at("cal", 4 * d + 1, r32(Math.sin(th), 24)); at("cal", 4 * d + 2, r32(Math.cos(2 * th), 24));
    at("cal", 4 * d + 3, Math.min(3, Math.floor(d / SEASON_DAYS)));
  }
  FOG_Z.forEach((z, n) => at("fogz", n, rq16(z)));
  FOG.forEach((row, si) => row.forEach((v, n) => at("fogrows", si * FOG_Z.length + n, rq24(v))));
  return { coldest: rq16(coldest), warmest: rq16(Math.max(...warm)) };
}
function tables(place: ClimatePlace): Tables {
  const l = layoutOf(), tab = new Int32Array(l.TAB_WORDS), { coldest, warmest } = fixedTables(tab, l);
  let flatYear = 0;
  place.seasons.forEach(({ t, sea, humid0, beam, glow }, si) => {
    const sun = sunRows(si, beam, glow, place.latDeg, place.turn ?? 0, false, l.SUN_MAX), row = (n: number) => l.TABO.seas + si * 16 + n;
    tab[row(SEAS.t)] = rq16(t); tab[row(SEAS.sea)] = rq16(sea); tab[row(SEAS.e0)] = rq16(humid0 * esat(t));
    tab[row(SEAS.flat)] = rq24(sun.flat);
    tab[row(SEAS.tb)] = rq16(beam); tab[row(SEAS.tg)] = rq16(glow);
    tab.set(sun.head, l.TABO.sun + si * l.SUN_STRIDE);
    sun.rows.forEach((v, q) => tab.set(v, l.TABO.sun + si * l.SUN_STRIDE + 8 + q * 8));
    flatYear += sun.flat;
  });
  return { tab, flatYear: rq16(flatYear), coldest, warmest };
}
// A patch's tables: the fixed words, and for each band of latitude its four seasons' sun rows (in the compass's axes; Bornholm's beam and glow through the cloud,
// the planet having none [gap]) with the band's flat-ground sun of the year in the first header's last word.
function patchTables(l: Layout, p: PatchInput): Tables {
  const tab = new Int32Array(l.TAB_WORDS), { coldest, warmest } = fixedTables(tab, l);
  if (p.bandsDeg.length > BANDS_MAX) throw new Error(`climateRestGpu: ${p.bandsDeg.length} bands of latitude, room for ${BANDS_MAX}`);
  p.bandsDeg.forEach((lat, b) => {
    let flatYear = 0;
    SEASONS.forEach(({ beam, glow }, si) => {
      const sun = sunRows(si, beam, glow, lat, 0, true, l.SUN_MAX), at = l.TABO.sunb + (b * NS + si) * l.SUN_STRIDE;
      tab.set(sun.head, at);
      sun.rows.forEach((v, q) => tab.set(v, at + 8 + q * 8));
      flatYear += sun.flat;
    });
    tab[l.TABO.sunb + b * NS * l.SUN_STRIDE + 7] = rq16(flatYear);
  });
  p.rose.forEach((v, k) => { tab[l.TABO.rosec + k] = Math.round(v * 2 ** 32) | 0; });
  tab.set(p.groups, l.TABO.grp);
  return { tab, flatYear: 0, coldest, warmest };
}
// The tables and the kernels' sources of each format and snow shift, made once each (the island's is the one place the game has had).
const built = new Map<string, { t: Tables; s: Sources }>();
const sourcesOf = (f: ClimateFormat, shift: number, t: Tables): Sources => ({
  prep: prepWgsl(f), air: airWgsl(f), shape: shapeWgsl(f), sun: sunWgsl(f), warm: warmWgsl(f), snow: snowWgsl({ coldest: t.coldest, warmest: t.warmest }, shift, f), pet: petWgsl(t.flatYear, f),
});
const kernelCache = new Map<string, Sources>();
function placed(place: ClimatePlace) {
  const key = `${place.latDeg}:${place.turn ?? 0}:${place.snowShift}:${place.seasons.map((s) => `${s.t},${s.sea},${s.humid0},${s.beam},${s.glow}`).join(";")}`;
  let b = built.get(key);
  if (!b) {
    const t = tables(place);
    b = { t, s: sourcesOf(ISLAND_CLIMATE, place.snowShift, t) };
    built.set(key, b);
  }
  return b;
}
const theTables = () => placed(ISLAND_PLACE).t;

// How far, in units of the last place of a word, the closest of the tables' exact values lies from a rounding tie: an
// engine whose Math.exp, cos, tanh or log is off by a unit in the last place of a double rounds the same words while
// this is over 1e-6 (a word of 2^24 times a value under 128 has a double's error of under 1e-6 of a unit).
export function tableMargin(): number {
  theTables();
  return least;
}

// The order the wind's wavefronts run in. Each bearing's air at a cell reads the cells round the place 1.5 cells upwind,
// so a cell is one level after the last of them it weights; (bearing, cell) pairs of one level are independent, and all
// sixteen bearings share the levels. The same for every island: made once (and once for each side of a patch).
const orders = new Map<string, { sched: Int32Array; list: Int32Array; levels: number }>();
function schedule(l: Layout) {
  const n = l.n, len = l.len;
  let order = orders.get(`${n}:${l.f.patch ? 1 : 0}`);
  if (order) return order;
  const dirs = Array.from({ length: DIRS }, (_, k) => [rq16(Math.cos((k / DIRS) * Math.PI * 2) * STEP), rq16(Math.sin((k / DIRS) * Math.PI * 2) * STEP)]);
  const level = new Int16Array(DIRS * len);
  let levels = 1;
  for (let k = 0; k < DIRS; k++) {
    const [cs, sn] = dirs[k], base = k * len;
    // a raster order, running from the side the air comes from, in which every cell a cell weights comes first
    for (let yy = 0; yy < n; yy++) {
      const y = sn < 0 ? n - 1 - yy : yy;
      for (let xx = 0; xx < n; xx++) {
        const x = cs < 0 ? n - 1 - xx : xx, ux = (x << 16) - cs, uy = (y << 16) - sn;
        if (ux < 0 || uy < 0 || ux > (n - 1) << 16 || uy > (n - 1) << 16) continue;
        const x0 = Math.min(n - 2, ux >> 16), y0 = Math.min(n - 2, uy >> 16), fx = ux - (x0 << 16), fy = uy - (y0 << 16);
        let lv = 0;
        for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
          if ((dx ? fx === 0 : fx === 65536) || (dy ? fy === 0 : fy === 65536)) continue;
          lv = Math.max(lv, level[base + (y0 + dy) * n + x0 + dx] + 1);
        }
        level[base + y * n + x] = lv;
        levels = Math.max(levels, lv + 1);
      }
    }
  }
  if (levels > l.MAX_LEVELS) throw new Error(`climateRestGpu: ${levels} wavefront levels, room for ${l.MAX_LEVELS}`);
  const start = new Int32Array(levels + 1);
  for (let e = 0; e < DIRS * len; e++) start[level[e] + 1]++;
  for (let v = 1; v <= levels; v++) start[v] += start[v - 1];
  const sched = new Int32Array(2 * l.MAX_LEVELS), list = new Int32Array(DIRS * len), fill = start.slice(0, levels);
  for (let v = 0; v < levels; v++) { sched[2 * v] = start[v]; sched[2 * v + 1] = start[v + 1] - start[v]; }
  // the island's cells are under 2^16, so a pair packs as (bearing << 16) | cell; a patch's list holds bearing * cells + cell
  for (let e = 0; e < DIRS * len; e++) { const k = (e / len) | 0; list[fill[level[e]]++] = l.f.patch ? e : (k << 16) | (e - k * len); }
  order = { sched, list, levels };
  orders.set(`${n}:${l.f.patch ? 1 : 0}`, order);
  return order;
}

type Sources = Record<"prep" | "air" | "shape" | "sun" | "warm" | "snow" | "pet", string>;

// ---------- the run ----------
export type Arena = { words: GPUBuffer; layout: Layout; destroy: () => void };

// The bits a patch's snow years' sums of rain are shifted down by: a year's rain of up to 3,000 mm a year times 2^this fits their words [derived: a cell holds at most 32,000 mm
// a season (air.ts WORD_MAX_MM, the words downstream hold Q16 in an i32), 128,000 mm a year, under 3,000 x 2^6 = 192,000].
export const PATCH_SNOW_SHIFT = 6;

// Runs every kernel, in one submission, and leaves the arena (the sections of SECTIONS) in a buffer for the function
// below.
export function runClimate(g: Gpu, input: ClimateRestInput): Arena {
  const { height, open, precip, angle } = input, patch = input.patch, n = Math.round(Math.sqrt(height.length));
  const f: ClimateFormat = patch ? { n, patch: true } : ISLAND_CLIMATE, l = layoutOf(f), len = l.len, place = input.place ?? ISLAND_PLACE;
  if (n * n !== height.length || (!patch && height.length !== LEN) || open.length !== len || precip.length !== NS || precip.some((p) => p.length !== len)) throw new Error("climateRestGpu: inputs of the wrong size");
  const shift = patch ? PATCH_SNOW_SHIFT : place.snowShift;
  let tallest = 0, wettest = 0;
  for (let i = 0; i < len; i++) {
    tallest = Math.max(tallest, Math.abs(height[i]));
    wettest = Math.max(wettest, precip[0][i] + precip[1][i] + precip[2][i] + precip[3][i]);
  }
  if (tallest > MOST_HEIGHT_M) throw new Error(`climateRestGpu: a height of ${tallest} m is past what the words hold`);
  if (wettest > MOST_RAIN_MM * 2 ** shift) throw new Error(`climateRestGpu: a year's rain of ${wettest} mm is past what the snow years' words hold`);
  const key = patch ? `patch:${n}` : null;
  let tabs: Tables, src: Sources;
  if (patch) {
    tabs = patchTables(l, patch);
    let k = kernelCache.get(key!);
    if (!k) kernelCache.set(key!, (k = sourcesOf(f, shift, tabs)));
    src = k;
  } else { const b = placed(place); tabs = b.t; src = b.s; }
  const sched = schedule(l), tab = tabs.tab.slice();
  if (!patch) {
    const rose = turned(place.rose as number[], angle - meanWay(place.rose as number[]));
    rose.forEach((share, k) => { tab[l.TABO.dirs + 4 * k + 2] = Math.round(share * 2 ** 32) | 0; });
  }
  tab.set(sched.sched, l.TABO.sched);
  tab.set(sched.list, l.TABO.lst);

  const inp = new Int32Array(l.INPUT_WORDS), SEC = l.SEC;
  for (let i = 0; i < len; i++) {
    inp[SEC.hq + i] = Math.round(height[i] * 65536);
    inp[SEC.open + i] = open[i];
    for (let s = 0; s < NS; s++) inp[SEC.precip + s * len + i] = Math.round(precip[s][i] * 65536);
  }
  if (patch) {
    for (let s = 0; s < NS; s++) { inp.set(patch.tS[s], SEC.tS + s * len); inp.set(patch.seaS[s], SEC.seaS + s * len); inp.set(patch.e0S[s], SEC.e0S + s * len); }
    inp.set(patch.wturn, SEC.wturn); inp.set(patch.band, SEC.band); inp.set(patch.gm, SEC.gm); inp.set(patch.dsea, SEC.dsea);
  }
  const W = storage(g, l.ARENA_WORDS * 4), TAB = storage(g, tab), CUR = storage(g, 16);
  g.device.queue.writeBuffer(W, 0, inp);


  const enc = g.device.createCommandEncoder(), pass = enc.beginComputePass(), bound = new Map<GPUComputePipeline, GPUBindGroup>();
  const run = (source: string, entry: string, x: number, y = 1) => {
    const p = pipeline(g, source, entry);
    let b = bound.get(p);
    if (!b) { b = g.device.createBindGroup({ layout: p.getBindGroupLayout(0), entries: [W, TAB, CUR].map((buffer, binding) => ({ binding, resource: { buffer } })) }); bound.set(p, b); }
    pass.setPipeline(p); pass.setBindGroup(0, b); pass.dispatchWorkgroups(x, y);
  };
  const cells = (source: string, entry: string, count = len) => { const [x, y] = cover(g, count, 64); run(source, entry, x, y); };
  cells(src.prep, "zinit");
  for (let p = 0; p < 3; p++) { cells(src.prep, "blur_x"); cells(src.prep, "blur_y"); }
  for (let v = 0; v < sched.levels; v++) { run(src.air, "air_step", Math.ceil(sched.sched[2 * v + 1] / 64)); run(src.air, "air_advance", 1); }
  cells(src.air, "air_reduce");
  cells(src.shape, "shape_main");
  cells(src.sun, "sun_main");
  cells(src.warm, "pool_main");
  cells(src.warm, "temp_main");
  cells(src.snow, "snow_init");
  cells(src.snow, "snow_main", patch ? l.GROUPS : len / 4);
  cells(src.pet, "pet_main");
  pass.end();
  g.device.queue.submit([enc.finish()]);
  return { words: W, layout: l, destroy: () => { W.destroy(); TAB.destroy(); CUR.destroy(); } };
}

// The climate's fields but the rain it was given (precip stays the caller's), on the GPU.
export async function climateRestGpu(g: Gpu, input: ClimateRestInput): Promise<ClimateRest> {
  const arena = runClimate(g, input), { SEC } = arena.layout;
  const words = new Int32Array(await readback(g, arena.words, (SEC.z - SEC.windShare) * 4, SEC.windShare * 4));
  arena.destroy();
  const field = (section: string, scale: number, which = 0) => {
    const f = new Float32Array(LEN), o = SEC[section] - SEC.windShare + which * LEN;
    for (let i = 0; i < LEN; i++) f[i] = words[o + i] / scale;
    return f;
  };
  const four = (section: string, scale: number) => Array.from({ length: NS }, (_, s) => field(section, scale, s));
  const pet = four("petS", 65536), sun = four("sunS", 2 ** 24), temp = four("tempS", 65536), humid = four("humidS", 65536), snowpack = four("snowpack", 65536);
  const lee = new Uint8Array(words.buffer, (SEC.lee - SEC.windShare) * 4, LEN * DIRS).slice();
  return {
    wind: [Math.cos(input.angle), Math.sin(input.angle)],
    seasons: Array.from({ length: NS }, (_, s) => ({ pet: pet[s], sun: sun[s], temp: temp[s], humid: humid[s], snowpack: snowpack[s] })),
    snow: field("snow", 65536), snowCover: field("snowCover", 65536), fog: field("fog", 2 ** 24), temp: field("temp", 65536),
    pet: field("pet", 65536), sun: field("sun", 65536), sky: field("sky", 65536), pool: field("pool", 65536),
    breeze: field("breeze", 65536), lee, windShare: field("windShare", 65536), salt: field("salt", 65536),
  };
}
