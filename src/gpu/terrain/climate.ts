// The rest of the island's climate on the GPU (kernels: wgsl/terrain-climate.ts): the wind and the salt, the horizons and
// the sky left open, the sun through the cloud, warmth, damp air and the pool of cold air, the snow years, and Penman's
// evaporation. The inputs are the heights, open water and the prevailing wind's angle, with the rain of each season
// beside them (rainGpu's output); the outputs are the Climate's fields in its units.
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
  esat, meanWay, midSeason, mulberry, turned,
} from "../../terrain/climate";
import { sunAt } from "../../sim/sky";
import type { Gpu } from "../device";
import { cover, pipeline, readback, storage } from "../kernel";
import {
  ARENA_WORDS, COVERS_N, DAYS, INPUT_WORDS, LOGIT_N, MAX_LEVELS, REACH_N, SAT_N, SEAS, SEC, SUN_MAX, SUN_STRIDE, TABO, TAB_WORDS,
  airWgsl, petWgsl, prepWgsl, shapeWgsl, snowWgsl, sunWgsl, warmWgsl,
} from "../wgsl/terrain-climate";

const NS = SEASONS.length;
// Most the words hold: a height or a depth in m (Q16 in an i32), and a cell's year of rain in mm (the snow years sum it,
// as Q16 a day, over ten years in 32 bits).
const MOST_HEIGHT_M = 32000, MOST_RAIN_MM = 3000;

export type ClimateRestInput = {
  // the ground as the generator's height field has it (the sea's depth negative), N x N
  height: Float32Array;
  // 1 over the sea and lakes
  open: Uint8Array;
  // each season's rain in mm over the season, N x N (rainGpu's)
  precip: Float32Array[];
  // the way the prevailing wind blows, in radians: the generator's one random draw for the climate, times 2 pi
  angle: number;
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

// Season si's middle day through the hours a quarter at a time: the header
// and one eight-word row for each hour the sun stands up, scaled as the kernel reads them (wgsl sunWgsl).
function sunRows(si: number) {
  const S0 = 1361, DT = 900, { beam: tb, glow: tg } = SEASONS[si], MJ = DT / 1e6;
  const rows: number[][] = [];
  let glow = 0, levelBeam = 0;
  for (let hour = 0; hour < 24; hour += DT / 3600) {
    const b = sunAt(midSeason(si), hour), sinEl = Math.sin(b.el);
    if (sinEl <= 0.005) continue;
    const am = 1 / (sinEl + 0.50572 * (b.el / (Math.PI / 180) + 6.07995) ** -1.6364), bn = S0 * 0.7 ** (am ** 0.678), cosEl = Math.cos(b.el);
    const kf = (((Math.atan2(b.dir[1], b.dir[0]) / (Math.PI * 2)) * DIRS) % DIRS + DIRS) % DIRS, k0 = Math.floor(kf);
    rows.push([rq16(cosEl * b.dir[0]), rq16(cosEl * b.dir[1]), rq16(sinEl), rq24(b.tan), rq24(bn * MJ), k0, rq16(kf - k0), 0]);
    glow += S0 * sinEl * Math.max(0, 0.271 - (0.294 * bn) / S0);
    levelBeam += bn * sinEl;
  }
  if (rows.length > SUN_MAX) throw new Error(`climateRestGpu: ${rows.length} sun samples, room for ${SUN_MAX}`);
  const level = levelBeam + glow, cloudy = tb * levelBeam + tg * glow;
  const head = [rows.length, rq16(tb), rq24(glow * MJ), rq24(level * MJ), rq24(cloudy * MJ), rq24(IN_CLOUD * level * MJ), rq24(tg * glow * MJ), 0];
  return { head, rows, flat: cloudy * MJ };
}

type Tables = { tab: Int32Array; flatYear: number; coldest: number; warmest: number };
function tables(): Tables {
  const tab = new Int32Array(TAB_WORDS), at = (name: string, i: number, v: number) => { tab[TABO[name] + i] = v; };
  const cs = Array.from({ length: DIRS }, (_, k) => [Math.cos((k / DIRS) * Math.PI * 2), Math.sin((k / DIRS) * Math.PI * 2)]);
  cs.forEach(([c, s], k) => {
    at("dirs", 4 * k, rq16(c * STEP)); at("dirs", 4 * k + 1, rq16(s * STEP));
    at("cs16", 2 * k, rq16(c)); at("cs16", 2 * k + 1, rq16(s));
  });
  let reach = 0;
  for (let d = 1; d < 110; d *= 1.2, reach++) { at("reach", 2 * reach, rq16(d)); at("reach", 2 * reach + 1, rq(256 / (d * CELL), 28)); }
  if (reach !== REACH_N) throw new Error(`climateRestGpu: ${reach} horizon distances, the kernel has ${REACH_N}`);
  let flatYear = 0;
  const days = [0, 0, 0, 0], warm = SNOW_SPREAD.map((s) => SNOW_HALF + 7.6 * s);
  for (let d = 0; d < 365; d++) days[Math.min(3, Math.floor(d / SEASON_DAYS))]++;
  SEASONS.forEach(({ t, sea, humid0, beam, glow }, si) => {
    const sun = sunRows(si), row = (n: number) => TABO.seas + si * 16 + n;
    tab[row(SEAS.t)] = rq16(t); tab[row(SEAS.sea)] = rq16(sea); tab[row(SEAS.e0)] = rq16(humid0 * esat(t)); tab[row(SEAS.poolc)] = rq24(POOL_C[si]);
    tab[row(SEAS.flat)] = rq24(sun.flat); tab[row(SEAS.warm)] = rq16(warm[si]); tab[row(SEAS.inv)] = rq24(1 / SNOW_SPREAD[si]); tab[row(SEAS.days)] = days[si];
    tab[row(SEAS.tb)] = rq16(beam); tab[row(SEAS.tg)] = rq16(glow);
    tab.set(sun.head, TABO.sun + si * SUN_STRIDE);
    sun.rows.forEach((v, q) => tab.set(v, TABO.sun + si * SUN_STRIDE + 8 + q * 8));
    flatYear += sun.flat;
  });
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
  return { tab, flatYear: rq16(flatYear), coldest: rq16(coldest), warmest: rq16(Math.max(...warm)) };
}
let built: Tables | null = null;
const theTables = () => (built ??= tables());

// How far, in units of the last place of a word, the closest of the tables' exact values lies from a rounding tie: an
// engine whose Math.exp, cos, tanh or log is off by a unit in the last place of a double rounds the same words while
// this is over 1e-6 (a word of 2^24 times a value under 128 has a double's error of under 1e-6 of a unit).
export function tableMargin(): number {
  theTables();
  return least;
}

// The order the wind's wavefronts run in. Each bearing's air at a cell reads the cells round the place 1.5 cells upwind,
// so a cell is one level after the last of them it weights; (bearing, cell) pairs of one level are independent, and all
// sixteen bearings share the levels. The same for every island: made once.
let order: { sched: Int32Array; list: Int32Array; levels: number } | null = null;
function schedule() {
  if (order) return order;
  const tab = theTables().tab, level = new Int16Array(DIRS * LEN);
  let levels = 1;
  for (let k = 0; k < DIRS; k++) {
    const cs = tab[TABO.dirs + 4 * k], sn = tab[TABO.dirs + 4 * k + 1], base = k * LEN;
    // a raster order, running from the side the air comes from, in which every cell a cell weights comes first
    for (let yy = 0; yy < N; yy++) {
      const y = sn < 0 ? N - 1 - yy : yy;
      for (let xx = 0; xx < N; xx++) {
        const x = cs < 0 ? N - 1 - xx : xx, ux = (x << 16) - cs, uy = (y << 16) - sn;
        if (ux < 0 || uy < 0 || ux > 255 << 16 || uy > 255 << 16) continue;
        const x0 = Math.min(254, ux >> 16), y0 = Math.min(254, uy >> 16), fx = ux - (x0 << 16), fy = uy - (y0 << 16);
        let l = 0;
        for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
          if ((dx ? fx === 0 : fx === 65536) || (dy ? fy === 0 : fy === 65536)) continue;
          l = Math.max(l, level[base + (y0 + dy) * N + x0 + dx] + 1);
        }
        level[base + y * N + x] = l;
        levels = Math.max(levels, l + 1);
      }
    }
  }
  if (levels > MAX_LEVELS) throw new Error(`climateRestGpu: ${levels} wavefront levels, room for ${MAX_LEVELS}`);
  const start = new Int32Array(levels + 1);
  for (let e = 0; e < DIRS * LEN; e++) start[level[e] + 1]++;
  for (let l = 1; l <= levels; l++) start[l] += start[l - 1];
  const sched = new Int32Array(2 * MAX_LEVELS), list = new Int32Array(DIRS * LEN), fill = start.slice(0, levels);
  for (let l = 0; l < levels; l++) { sched[2 * l] = start[l]; sched[2 * l + 1] = start[l + 1] - start[l]; }
  for (let e = 0; e < DIRS * LEN; e++) { const k = (e / LEN) | 0; list[fill[level[e]]++] = (k << 16) | (e - k * LEN); }
  return (order = { sched, list, levels });
}

type Sources = Record<"prep" | "air" | "shape" | "sun" | "warm" | "snow" | "pet", string>;
const sources = (): Sources => {
  const { flatYear, coldest, warmest } = theTables();
  return { prep: prepWgsl(), air: airWgsl(), shape: shapeWgsl(), sun: sunWgsl(), warm: warmWgsl(), snow: snowWgsl({ coldest, warmest }), pet: petWgsl(flatYear) };
};
let code: Sources | null = null;

// ---------- the run ----------
export type Arena = { words: GPUBuffer; destroy: () => void };

// Runs every kernel, in one submission, and leaves the arena (the sections of SECTIONS) in a buffer for the function
// below.
export function runClimate(g: Gpu, input: ClimateRestInput): Arena {
  const { height, open, precip, angle } = input;
  if (height.length !== LEN || open.length !== LEN || precip.length !== NS || precip.some((p) => p.length !== LEN)) throw new Error("climateRestGpu: inputs of the wrong size");
  let tallest = 0, wettest = 0;
  for (let i = 0; i < LEN; i++) {
    tallest = Math.max(tallest, Math.abs(height[i]));
    wettest = Math.max(wettest, precip[0][i] + precip[1][i] + precip[2][i] + precip[3][i]);
  }
  if (tallest > MOST_HEIGHT_M) throw new Error(`climateRestGpu: a height of ${tallest} m is past what the words hold`);
  if (wettest > MOST_RAIN_MM) throw new Error(`climateRestGpu: a year's rain of ${wettest} mm is past what the snow years' words hold`);
  const src = (code ??= sources()), sched = schedule();
  const rose = turned(ROSE, angle - meanWay(ROSE));
  const tab = theTables().tab.slice();
  rose.forEach((share, k) => { tab[TABO.dirs + 4 * k + 2] = Math.round(share * 2 ** 32) | 0; });
  tab.set(sched.sched, TABO.sched);
  tab.set(sched.list, TABO.lst);

  const inp = new Int32Array(INPUT_WORDS);
  for (let i = 0; i < LEN; i++) {
    inp[SEC.hq + i] = Math.round(height[i] * 65536);
    inp[SEC.open + i] = open[i];
    for (let s = 0; s < NS; s++) inp[SEC.precip + s * LEN + i] = Math.round(precip[s][i] * 65536);
  }
  const W = storage(g, ARENA_WORDS * 4), TAB = storage(g, tab), CUR = storage(g, 16);
  g.device.queue.writeBuffer(W, 0, inp);

  const enc = g.device.createCommandEncoder(), pass = enc.beginComputePass(), bound = new Map<GPUComputePipeline, GPUBindGroup>();
  const run = (source: string, entry: string, x: number, y = 1) => {
    const p = pipeline(g, source, entry);
    let b = bound.get(p);
    if (!b) { b = g.device.createBindGroup({ layout: p.getBindGroupLayout(0), entries: [W, TAB, CUR].map((buffer, binding) => ({ binding, resource: { buffer } })) }); bound.set(p, b); }
    pass.setPipeline(p); pass.setBindGroup(0, b); pass.dispatchWorkgroups(x, y);
  };
  const cells = (source: string, entry: string, n = LEN) => { const [x, y] = cover(g, n, 64); run(source, entry, x, y); };
  cells(src.prep, "zinit");
  for (let p = 0; p < 3; p++) { cells(src.prep, "blur_x"); cells(src.prep, "blur_y"); }
  for (let l = 0; l < sched.levels; l++) { run(src.air, "air_step", Math.ceil(sched.sched[2 * l + 1] / 64)); run(src.air, "air_advance", 1); }
  cells(src.air, "air_reduce");
  cells(src.shape, "shape_main");
  cells(src.sun, "sun_main");
  cells(src.warm, "pool_main");
  cells(src.warm, "temp_main");
  cells(src.snow, "snow_init");
  cells(src.snow, "snow_main", LEN / 4);
  cells(src.pet, "pet_main");
  pass.end();
  g.device.queue.submit([enc.finish()]);
  return { words: W, destroy: () => { W.destroy(); TAB.destroy(); CUR.destroy(); } };
}

// The climate's fields but the rain it was given (precip stays the caller's), on the GPU.
export async function climateRestGpu(g: Gpu, input: ClimateRestInput): Promise<ClimateRest> {
  const arena = runClimate(g, input);
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
