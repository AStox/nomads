// The water in what lies out (wgsl/moisture.ts, driven by moisture.ts): the GPU's hours against the TypeScript twin bit
// for bit on both of the dev machine's adapters, every texel class and every log of a pine stand under varied air,
// rain and sun; and under uniform weather a lying stick's water equal to the island's reference for its thickness
// (wetness.ts deadHour), hour after hour (plan Unit 12).
import { afterAll, expect, test } from "bun:test";
import { type Gpu, openGpu, releaseGpu, theGpu } from "./device";
import { readback, storage } from "./kernel";
import { type Field, Store } from "./store";
import { Crowns } from "./crowns";
import { Deadwood, type ClastKind, lam, lasts } from "./deadwood";
import { CELLS, CROWN_WORDS, QSHIFT, SIDE, TEXELS, TEXEL_MM } from "./wgsl/crowns";
import {
  CELL_WORDS, CLASSES, HOUR_FIELDS, Moisture, TEXEL_WORDS, cellAir, envQ, fromW, logLaw, logTables, step, texelHour, toW, FSP,
  type Env, type Hour, type MoistureDriver, type Water,
} from "./moisture";
import { N } from "../terrain/grid";
import { DIRS } from "../terrain/climate";
import { SPECIES } from "../terrain/flora";
import { stemTables } from "../sim/plants";
import { shelterTables } from "../sim/air";
import { deadHour, islandCell } from "../sim/wetness";
import { newWorld, type Dead } from "../sim/world";

let low: Gpu | null = null;
afterAll(async () => { low?.device.destroy(); await releaseGpu(); });

const SEED = 0x5eed;
const U = (name: string): Field => ({ name, type: "u32", unit: "", scale: 1 });
const PLANT_FIELDS = ["what", "size", "seed", "q", "peak", "crop"].map(U);
const PINE = SPECIES.indexOf("pine"), OAK = SPECIES.indexOf("oak");
const noClasts = (): Record<ClastKind, Uint32Array> => ({ pebble: new Uint32Array(CELLS), stone: new Uint32Array(CELLS), boulder: new Uint32Array(CELLS) });
const Q = (x: number) => Math.round(x * 65536);
const SHELTER = shelterTables();

// A stand over a square block of cells: every texel one tree, pines and oaks by turns, each a height and a crown's share
// of its texel of its own, filed as the stems' law would; the texels of a block's first row left bare.
function stand(s: Store, x0: number, y0: number, side: number) {
  const trees: { t: number; h: number; a: number; sp: number }[] = [];
  for (let cy = y0; cy < y0 + side; cy++)
    for (let cx = x0; cx < x0 + side; cx++)
      for (let j = 0; j < 16; j++) {
        const tx = cx * 4 + (j % 4), ty = cy * 4 + Math.floor(j / 4);
        if (cy === y0 && Math.floor(j / 4) === 0) continue;
        trees.push({ t: ty * SIDE + tx, h: 9000 + ((tx * 7 + ty * 13) % 20) * 700, a: 9000 + ((tx * 11 + ty * 5) % 30) * 3000, sp: (tx + ty) % 2 ? PINE : OAK });
      }
  const n = trees.length, cols = { x: new Uint32Array(n), y: new Uint32Array(n), what: new Uint32Array(n), size: new Uint32Array(n) };
  trees.forEach((tr, e) => {
    cols.x[e] = (tr.t % SIDE) * TEXEL_MM + TEXEL_MM / 2; cols.y[e] = Math.floor(tr.t / SIDE) * TEXEL_MM + TEXEL_MM / 2;
    cols.what[e] = tr.sp << 8; cols.size[e] = tr.h;
  });
  s.declare({ name: "plant", capacity: n, placed: true, still: true, fields: PLANT_FIELDS });
  s.write("plant", n, cols);
  // the raster as the stems' law files it, with its texel sums (wgsl/stems.ts stemsFile): a pine is a tree of row 0
  const start = new Uint32Array(TEXELS + 1), list = new Uint32Array(3 * n), sums = new Uint32Array(CROWN_WORDS * TEXELS), at = new Map(trees.map((tr, e) => [tr.t, e]));
  const rows = stemTables().rows;
  let p = 0;
  for (let t = 0; t < TEXELS; t++) {
    start[t] = p;
    const e = at.get(t);
    if (e === undefined) continue;
    const { h, a, sp } = trees[e], k = (a >>> 8) + 1;
    list[3 * p] = e; list[3 * p + 1] = (h << 1) | 1; list[3 * p + 2] = a; p++;
    sums.set([rows[Math.min(sp, 31)] === 0 ? a : 0, rows[Math.min(sp, 31)] === 0 ? 0 : a, k, k * Math.floor(h / 100)], CROWN_WORDS * t);
  }
  start[TEXELS] = p;
  return { start: storage(s.g, start), list: storage(s.g, list), crowns: storage(s.g, sums) };
}

// Land cells round the stand, their season fields drawn from a seeded stream (or all the island cell's, uniform).
const LAND = { x0: 96, y0: 96, side: 9 };
type Driver = MoistureDriver & { cellsArr: Int32Array; leeArr: Uint8Array };
function driverOf(uniform: { cells: Int32Array; lee: Uint8Array } | null, start: Water[]): Driver {
  let seed = 3;
  const rand = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  const cells = new Int32Array(N * N * CELL_WORDS), lee = new Uint8Array(N * N * DIRS);
  for (let y = LAND.y0; y < LAND.y0 + LAND.side; y++)
    for (let x = LAND.x0; x < LAND.x0 + LAND.side; x++) {
      const c = y * N + x, b = c * CELL_WORDS;
      if (uniform) { cells.set(uniform.cells, b); lee.set(uniform.lee, c * DIRS); continue; }
      for (let k = 0; k < 4; k++) {
        cells[b + k] = Q(rand() * 4 - 2); cells[b + 4 + k] = Q(0.6 + rand() * 0.8); cells[b + 8 + k] = Q(0.3 + rand() * 1.5);
      }
      cells[b + 12] = Q(rand() * 0.8); cells[b + 13] = Q(rand() * 0.2 - 0.1); cells[b + 14] = Q(rand() * 0.2 - 0.1); cells[b + 15] = 1;
      for (let k = 0; k < DIRS; k++) lee[c * DIRS + k] = 30 + Math.floor(rand() * 70);
    }
  return { cells: () => cells, lee: () => lee, shelter: () => SHELTER, start: () => start, cellsArr: cells, leeArr: lee };
}
// Hours of varied weather: dry and sunny, a shower, a storm, still nights, the wind turning, the soil drying.
function hours(n: number): Hour[] {
  return Array.from({ length: n }, (_, i) => {
    const wet = i % 7 === 3 ? 1 : i % 11 === 5 ? 5 : 0, k = i % 16, a = (2 * Math.PI * k) / 16;
    return {
      hour: i + 1, s: Math.floor(i / 9) % 4, f: Q((i % 9) / 9), temp: Q(4 + 14 * Math.sin(i / 4)), pooled: Q(i % 24 < 6 ? 2.5 : 0), wet, speed: Q(1 + (i % 5) * 2),
      k, ux: Q(Math.cos(a)), uy: Q(Math.sin(a)), v: wet ? Q(4.5) : 0, sun: Q(i % 24 < 12 ? 300 + 50 * (i % 6) : 0), kr: Q(0.2 + 0.05 * (i % 10)),
      tp: Q(0.3 + 0.02 * (i % 20)), tb: Q(0.5 + 0.02 * (i % 20)),
    };
  });
}
const START = CLASSES.map((_, i) => ({ m: toW(0.12 + 0.01 * i), skin: toW(0.15 + 0.01 * i) }));

async function staged(g: Gpu, uniform: { cells: Int32Array; lee: Uint8Array } | null) {
  const s = new Store(g), r = stand(s, 99, 99, 3);
  const raster = () => r;
  const crowns = new Crowns();
  await crowns.attach(s, { raster }, () => false);
  const dead = new Deadwood(SEED, noClasts(), { logs: 1 << 14, bins: 1 << 12 });
  dead.attach(s, raster);
  const driver = driverOf(uniform, START), moist = new Moisture();
  moist.attach(s, crowns, dead, driver);
  return { s, crowns, dead, moist, driver };
}

// The twin over the same hours: every land texel's classes, then every log (its law read from the log kinds' bodies).
function twin(d: Driver, words: Uint32Array, hs: Hour[], log: Uint32Array, up: Uint32Array, L: { log: Record<string, number>; up: Record<string, number>; logCap: number; upCap: number }) {
  const texels = new Map<number, Water[]>(), logs = new Map<number, { x: Water; tag: number }>(), t0 = logTables();
  const land: number[] = [];
  for (let y = LAND.y0; y < LAND.y0 + LAND.side; y++) for (let x = LAND.x0; x < LAND.x0 + LAND.side; x++) for (let j = 0; j < 16; j++) land.push((y * 4 + (j >> 2)) * SIDE + x * 4 + (j & 3));
  for (const t of land) texels.set(t, START.map((w) => ({ ...w })));
  for (const H of hs) {
    const env = new Map<number, Env>();
    for (const t of land) {
      const c = (Math.floor(t / SIDE) >> 2) * N + ((t % SIDE) >> 2), air = cellAir(d.cellsArr, d.leeArr, c, H)!;
      const w = words[t], e = envQ(air, (w & 0xffff) << QSHIFT, (w >>> 16) << QSHIFT, words[TEXELS + c], H, SHELTER);
      env.set(t, e);
      texels.set(t, texelHour(texels.get(t)!, e));
    }
    for (let k = 0; k < L.logCap + L.upCap; k++) {
      const isUp = k >= L.logCap, b = isUp ? up : log, F = isUp ? L.up : L.log, cap = isUp ? L.upCap : L.logCap, i = isUp ? k - L.logCap : k;
      const word = b[i];
      if (!(word & 1)) continue;
      const at = (f: string) => b[(1 + F[f]) * cap + i];
      const t = Math.min(Math.floor(at("y") / TEXEL_MM), SIDE - 1) * SIDE + Math.min(Math.floor(at("x") / TEXEL_MM), SIDE - 1);
      const born = at("born"), fr = at("fr"), standing = fr !== 0 && lasts(at("uf"), lam((H.hour - born) >>> 0, fr)), lying = !standing;
      let s = logs.get(k);
      if (!s || (s.tag & 0x7fffffff) !== word) {
        const cls = texels.get(t)![lying ? 2 : 4];
        s = born <= 0 ? { x: { ...cls }, tag: word } : { x: { m: t0.rows[Math.min(at("what"), 31) * 4 + 2], skin: t0.rows[Math.min(at("what"), 31) * 4 + 2] }, tag: (word | 0x80000000) >>> 0 };
      }
      const green = (s.tag & 0x80000000) !== 0 && s.x.m > toW(FSP), e = env.get(t)!;
      const law = logLaw(t0.rows, t0.ex, at("what"), at("dia"), green);
      s.x = step(s.x, law, e.rain, lying ? e.lying : e.aloft);
      if (!green) s.tag = s.tag & 0x7fffffff;
      logs.set(k, s);
    }
  }
  return { texels, logs };
}

async function run(g: Gpu) {
  const { s, crowns, dead, moist, driver } = await staged(g, null), hs = hours(40);
  s.flush();
  const words = new Uint32Array(await readback(g, crowns.buf!));
  for (const [i, H] of hs.entries()) { moist.queue(H); await s.step((i + 1) * 12); }
  s.flush();
  const states = new Int32Array(await readback(g, moist.states!));
  const lk = s.kind("log"), uk = s.kind("logup");
  const L = {
    logCap: lk.capacity, upCap: uk.capacity,
    log: Object.fromEntries(["x", "y", "born", "what", "dia", "uf", "fr"].map((f) => [f, lk.field[f]])),
    up: Object.fromEntries(["x", "y", "born", "what", "dia", "uf", "fr"].map((f) => [f, uk.field[f]])),
  };
  const want = twin(driver, words, hs, await s.read("log", "body"), await s.read("logup", "body"), L);
  let logsSeen = 0;
  for (const [t, ws] of want.texels) ws.forEach((x, i) => { expect([states[t * TEXEL_WORDS + 2 * i], states[t * TEXEL_WORDS + 2 * i + 1]]).toEqual([x.m, x.skin]); });
  for (const [k, l] of want.logs) {
    const at = TEXELS * TEXEL_WORDS + 3 * k;
    expect([states[at], states[at + 1], states[at + 2] >>> 0]).toEqual([l.x.m, l.x.skin, l.tag >>> 0]);
    logsSeen++;
  }
  expect(logsSeen).toBeGreaterThan(10);
  moist.destroy(); crowns.destroy(); dead.destroy(); s.destroy();
  return Array.from(states.subarray(0, TEXELS * TEXEL_WORDS + 3 * (L.logCap + L.upCap)).filter((_, i) => i % 97 === 0));
}

test("an hour of the water in what lies out equals the twin bit for bit, every class of every texel and every log, on both adapters", async () => {
  const a = await run(await theGpu());
  low = await openGpu("low-power");
  const b = await run(low);
  expect(b).toEqual(a);
}, 600_000);

test("a lying stick's water equals the island's reference for its thickness under uniform weather, hour after hour", async () => {
  const w = newWorld(1), isle = islandCell(w), { s, moist } = await staged(await theGpu(), isle);
  // the reference starting where the texels start, stepped by the sim's own deadHour
  let ref: Dead = { open: START.map((x) => fromW(x.m)), shade: START.map((x) => fromW(x.m)), skin: { open: START.map((x) => fromW(x.skin)), shade: START.map((x) => fromW(x.skin)) } };
  // a bare texel (the stand's first row) in the uniform land
  const bare = (99 * 4) * SIDE + 99 * 4 + 1, STICK = CLASSES.findIndex((c) => c.name === "stick");
  for (const [i, H] of hours(30).entries()) {
    moist.queue(H);
    await s.step((i + 1) * 12);
    ref = deadHour(w, ref, H);
    s.flush();
    const st = new Int32Array(await readback(s.g, moist.states!, TEXEL_WORDS * 4, bare * TEXEL_WORDS * 4));
    expect([st[2 * STICK], st[2 * STICK + 1]]).toEqual([toW(ref.open[STICK]), toW(ref.skin!.open[STICK])]);
  }
  moist.destroy(); s.destroy();
}, 600_000);
