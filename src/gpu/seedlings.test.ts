// The seeds' and seedlings' law (wgsl/seedlings.ts, driven by seedlings.ts; constants src/sim/seeds.ts): a TypeScript
// single-step oracle of a whole day (what src/sim/recruits.ts did, as the GPU now does it), bit for bit on both of the
// dev machine's adapters; the streamed seed against the same seed stepped as an active object; and the plan's checks
// (Unit 8): the kernels' landings, water and full crowns, a dead parent's shed, the young standing up as stems, and
// seed 1's seedling densities against the field.
import { afterAll, expect, test } from "bun:test";
import { openGpu, releaseGpu, theGpu, type Gpu } from "./device";
import { Store, type Kind } from "./store";
import { Flora, PLANT, type StemDay, type StemDriver } from "./flora";
import { SEEDLING, Seedlings, type SeedDriver, type SeedLaw } from "./seedlings";
import { cover, readback, storage } from "./kernel";
import { stemDriver, stemTables } from "../sim/plants";
import { seedDriver, seedLaw } from "../sim/seeds";
import { DAY, YEAR_DAYS, heldStore, islandOf, newWorld } from "../sim/world";
import { resident, seedlingsOf } from "../sim/space";
import { residentAnimals } from "../sim/animals";
import { FLORA, SPECIES, TILES, TILE_M, type Scatter } from "../terrain/flora";
import { CELL, N } from "../terrain/grid";
import { CELLS } from "./wgsl/index";
import { CTL_WORDS } from "./wgsl/alloc";
import { DIED, HALF_Q, HC, HQ, LAID, MAP, QSTEP, ROWS, ROW_WORDS, RW, SSTEP, TEXELS, TEXELS_SIDE, TEXEL_MM, TREE_ROWS } from "./wgsl/stems";
import { layered } from "./wgsl/crowns";
import {
  BERRY, BLOCKS, BLOCKS_SIDE, BLOCK_CELLS, COS, GMIX, GRAD, LAYER, LAYERS, MODE, ON_TREE, PI_Q16, SD, STREAM, YOUNG_WORDS,
  seedLandings, seedStep, type PlantLayout,
} from "./wgsl/seedlings";
import { binom, feistel, fkeys, next32, philox, qexpo, qgammav, qlognormal, qpoisson, rinit, unif } from "./rand";
import { type U64, mul64, mulhi64, qmul, qpow } from "./fixed";

await islandOf(1);

afterAll(releaseGpu);

const K = (k: (typeof FLORA)[number]) => FLORA.indexOf(k), S = (s: (typeof SPECIES)[number]) => SPECIES.indexOf(s);
const TABLES = stemTables();
const TEXEL_M = TEXEL_MM / 1000, NT = TEXELS, ISLE = N * CELL * 1000, BMM = BLOCK_CELLS * CELL * 1000;
const SEED = 7;
// The law with a day a tick, so a store's every step is a law day.
const LAW: SeedLaw = { ...seedLaw(SEED), dayTicks: 1 };

// ---------- the oracle ----------
type BL = { cap: number; texel: number; what: number; born: number; n: number; n0: number; q: number; peak: number };
const at = (k: Kind, name: string) => (1 + k.field[name]) * k.capacity;
const plantLayout = (k: Kind): PlantLayout => ({ cap: k.capacity, x: at(k, "x"), y: at(k, "y"), what: at(k, "what"), size: at(k, "size"), seed: at(k, "seed"), q: at(k, "q"), peak: at(k, "peak"), crop: at(k, "crop") });
const binLayout = (k: Kind): BL => ({ cap: k.capacity, texel: at(k, "texel"), what: at(k, "what"), born: at(k, "born"), n: at(k, "n"), n0: at(k, "n0"), q: at(k, "q"), peak: at(k, "peak") });
const rowOfStem = (b: Uint32Array, P: PlantLayout, i: number) => TABLES.rows[Math.min(b[P.what + i] >>> 8, MAP - 1)];
function heightAt(r: number, q: number) {
  const t = TABLES.tables, j = Math.min(q >>> QSTEP, HQ - 2), lo = t[r * HQ + j], hi = t[r * HQ + j + 1], f = Math.min(q - j * 2 ** QSTEP, 2 ** QSTEP);
  return lo + Math.floor(((hi - lo) * f) / 2 ** QSTEP);
}
function crownAt(r: number, s: number) {
  const t = TABLES.tables, base = TREE_ROWS * HQ + r * HC, j = Math.min(s >>> SSTEP, HC - 2), lo = t[base + j], hi = t[base + j + 1], f = Math.min(s - j * 2 ** SSTEP, 2 ** SSTEP);
  return lo + Math.floor(((hi - lo) * f) / 2 ** SSTEP);
}
const youngHeight = (r: number, q: number) => (r === BERRY ? LAW.bushMm : heightAt(r, q));
const hi16 = (p: U64) => ((p[1] << 16) | (p[0] >>> 16)) >>> 0;
const mix = (gen: number) => (SEED ^ Math.imul(gen, GMIX)) >>> 0;
const texelOf = (x: number, y: number) => Math.min(Math.floor(y / TEXEL_MM), TEXELS_SIDE - 1) * TEXELS_SIDE + Math.min(Math.floor(x / TEXEL_MM), TEXELS_SIDE - 1);
const cellOfTexel = (t: number) => Math.floor(Math.floor(t / TEXELS_SIDE) / 4) * N + Math.floor((t % TEXELS_SIDE) / 4);

// The stems' crown raster as the stems' law files it from the body it starts the day with: by texel, each live stem's
// height and crown share.
function rasterOf(b: Uint32Array, P: PlantLayout) {
  const out = new Map<number, [number, number][]>();
  for (let i = 0; i < P.cap; i++) {
    if (!(b[i] & 1)) continue;
    const t = texelOf(b[P.x + i], b[P.y + i]), s = b[P.size + i];
    let l = out.get(t);
    if (!l) out.set(t, (l = []));
    l.push([s, crownAt(rowOfStem(b, P, i), s)]);
  }
  return out;
}
function lightAt(raster: Map<number, [number, number][]>, t: number, s: number) {
  let above = 0;
  for (const [h, a] of raster.get(t) ?? []) if (h > s) above += a; else if (h === s) above += a >>> 1;
  return layered(above);
}
// wgsl/seedlings.ts landing and reach
function landing(dry: Uint32Array, x0: number, y0: number, d: number) {
  const j = next32() >>> 22, c = COS[j], s = COS[(j + 768) & 1023];
  const ax = hi16(mul64(d, Math.abs(c))) | 0, ay = hi16(mul64(d, Math.abs(s))) | 0;
  const x = (x0 | 0) + (c < 0 ? -ax : ax), y = (y0 | 0) + (s < 0 ? -ay : ay);
  if (x < 0 || y < 0 || x >= ISLE || y >= ISLE) return NT;
  const t = texelOf(x, y);
  return (dry[t >>> 5] >>> (t & 31)) & 1 ? t : NT;
}
function reach(r: number, h: number) {
  if (r === 0) return mulhi64(mul64(h, qexpo() >>> 0), LAW.pineMean)[0];
  if (r === 1) return hi16(mul64(Math.max(qlognormal(LAW.oakMu, LAW.oakSigma), 0) >>> 0, 1000));
  const g = qgammav(LAW.ashShape);
  return g <= 0 ? 0 : hi16(mul64(LAW.ashScale, qpow(g, LAW.ashPow) >>> 0));
}
const isqrt = (v: number) => { let r = Math.floor(Math.sqrt(v)); while (r * r > v) r--; while ((r + 1) * (r + 1) <= v) r++; return r; };

type Day = { day: number; pre: Uint32Array; post: Uint32Array; bins: Uint32Array; alloc: Uint32Array; pend: Uint32Array; sd: Uint32Array; animals: [number, number, number][]; requests: number[] };
// A whole law day: what the GPU's bins and seed in the soil are after it, from what they were and the stems before and
// after the stems' law (no bin marked to stand up).
function oracleDay(P: PlantLayout, B: BL, d: Day) {
  const b = d.bins.slice(), pend = d.pend.slice(), sd = d.sd, raster = rasterOf(d.pre, P), post = d.post;
  const doy = d.day % LAW.yearDays, year = Math.floor(d.day / LAW.yearDays), dry = sd.subarray(SD.dry);
  // the deer and rabbits by block
  const work = new Uint32Array(2 * BLOCKS);
  for (const [x, y, sp] of d.animals) if (sp <= 1) work[sp * BLOCKS + Math.min(Math.floor(y / BMM), BLOCKS_SIDE - 1) * BLOCKS_SIDE + Math.min(Math.floor(x / BMM), BLOCKS_SIDE - 1)]++;
  // a day of every bin
  for (let i = 0; i < B.cap; i++) {
    if (!(b[i] & 1)) continue;
    const r = b[B.what + i] & 255, t = b[B.texel + i], cell = cellOfTexel(t), q = b[B.q + i];
    const L = lightAt(raster, t, youngHeight(r, q)), w = SD.young + cell * YOUNG_WORDS + r * 4;
    let nq: number;
    if (r === BERRY || q < LAW.qup[r]) {
      const gain = Math.floor((sd[w] * L) / 65536) - sd[w + 1];
      nq = q + (((q >>> 5) * gain) >> 11);
      if (r === BERRY) nq = Math.min(nq, LAW.qup[BERRY]);
    } else nq = q + Math.floor((sd[w + 2] * L) / 65536) - sd[w + 3];
    nq = Math.max(0, Math.min(TABLES.rows[MAP + r * ROW_WORDS + RW.qmax], nq));
    const peak = Math.max(b[B.peak + i], nq);
    if (nq === 0 || nq < Math.floor(((peak >>> 8) * HALF_Q) / 256)) { b[i] &= ~1; continue; }
    const s = youngHeight(r, nq), ty = Math.floor(t / TEXELS_SIDE), tx = t % TEXELS_SIDE;
    const blk = Math.min(Math.floor((ty * TEXEL_MM) / BMM), BLOCKS_SIDE - 1) * BLOCKS_SIDE + Math.min(Math.floor((tx * TEXEL_MM) / BMM), BLOCKS_SIDE - 1);
    const kd = s < LAW.deerReach ? sd[SD.browse + Math.min(work[blk], 1023)] : 0, kr = s < LAW.rabbitReach ? sd[SD.browse + 1024 + Math.min(work[BLOCKS + blk], 1023)] : 0;
    const kill = Math.min(kd + kr - Math.floor((kd * kr) / 65536), 65535);
    let n = b[B.n + i];
    if (kill > 0) { rinit(mix(b[i] >>> 1), STREAM.browse, i, d.day); n -= binom(n, (kill << 16) >>> 0); }
    if (n === 0) { b[i] &= ~1; continue; }
    b[B.q + i] = nq; b[B.peak + i] = peak; b[B.n + i] = n;
    const st = sd[SD.stand + cell * 4 + r];
    if (r < 4 ? st > 0 && s >= st : nq >= LAW.qup[BERRY] && d.day - b[B.born + i] >= LAW.bramDays) b[B.what + i] = r | GRAD;
  }
  // the day's sheds, each parent's seed one by one
  const drop = (layer: number, t: number) => { if (t < NT) pend[layer * NT + t]++; };
  LAW.layers.forEach((ly, layer) => {
    if (layer === LAYER.sucker || doy < ly.from || doy >= ly.to || (ly.parity >= 0 && (year & 1) !== ly.parity)) return;
    const mode = [MODE.seeds, MODE.seeds, MODE.seeds, MODE.seeds, MODE.berry, MODE.daughter][layer], dd = doy - ly.from, S = ly.to - ly.from;
    for (let i = 0; i < P.cap; i++) {
      if (!(post[i] & 1) || rowOfStem(post, P, i) !== ly.row) continue;
      const c0 = post[P.crop + i];
      if (mode === MODE.seeds && (c0 === 0 || c0 === DIED)) continue;
      const m = mix(post[i] >>> 1), x0 = post[P.x + i], y0 = post[P.y + i], h = post[P.size + i];
      if (mode === MODE.seeds) {
        for (let bk = dd; bk < Math.ceil(c0 / 4); bk += S) {
          const w4 = philox([i, bk, 0, 0], [m, (STREAM.surv + year) >>> 0]);
          for (let j = 0; j < 4 && 4 * bk + j < c0; j++) {
            if (w4[j] >= LAW.survive[ly.row]) continue;
            rinit(m, (STREAM.land + year) >>> 0, i, 4 * bk + j);
            drop(layer, landing(dry, x0, y0, reach(ly.row, h)));
          }
        }
        continue;
      }
      let c: number;
      if (mode === MODE.berry) {
        rinit(m, (STREAM.berry + year) >>> 0, i, 0);
        const rq = Math.floor(((h << 16) >>> 0) / 2000) | 0;
        c = qpoisson(qmul(qmul(qmul(rq, rq), PI_Q16), LAW.berryArea));
      } else { rinit(m, (STREAM.daughter + year) >>> 0, i, 0); c = next32() < LAW.daughter ? 1 : 0; }
      for (let s = 0; s < c; s++) {
        rinit(m, (STREAM.land + year) >>> 0, i, s);
        drop(layer, landing(dry, x0, y0, mode === MODE.berry ? hi16(mul64(LAW.birdMean, qexpo() >>> 0)) : LAW.cane));
      }
    }
  });
  // the suckers
  for (let w = 0; w < Math.min(d.requests.length / 3, 1024); w++) {
    const [x0, y0, id] = d.requests.slice(3 * w, 3 * w + 3);
    rinit(SEED, STREAM.sucker, id, d.day);
    let c = 0;
    for (let k = 0; k < 4; k++) c += qpoisson(LAW.suckerLam);
    for (let s = 0; s < c; s++) {
      rinit((SEED ^ id) >>> 0, (STREAM.sland + d.day) >>> 0, id, s);
      drop(LAYER.sucker, landing(dry, x0, y0, Math.floor((LAW.suckerReach * isqrt(next32())) / 65536)));
    }
  }
  // the layers coming up, a bin a texel, born as the store's births place them
  let head = d.alloc[0], tail = d.alloc[2];
  const nfree = d.alloc[1];
  LAW.layers.forEach((ly, layer) => {
    if (!(ly.up < 0 || (doy === ly.up && (ly.parity < 0 || ((year - ly.lag) & 1) === ly.parity)))) return;
    const avail = nfree - head;
    let j = 0;
    for (let t = 0; t < NT; t++) {
      const nn = pend[layer * NT + t];
      if (!nn || (layer === LAYER.pine && lightAt(raster, t, 0) < LAW.pineLight)) continue;
      const slot = j < avail ? d.alloc[CTL_WORDS + head + j] : tail + (j - avail);
      j++;
      if (slot >= B.cap) continue;
      const gen = (((b[slot] >>> 1) + 1) & 0x7fffffff) || 1;
      b[slot] = ((gen << 1) | 1) >>> 0;
      b[B.texel + slot] = t; b[B.what + slot] = ly.row; b[B.born + slot] = d.day; b[B.n + slot] = nn; b[B.n0 + slot] = nn; b[B.q + slot] = ly.q0; b[B.peak + slot] = ly.q0;
    }
    const used = Math.min(j, avail);
    head += used; tail += Math.min(j - used, B.cap - tail);
    pend.fill(0, layer * NT, (layer + 1) * NT);
  });
  // every texel's bins thinned to its room, from the day's bins as filed
  const filed = new Map<number, [number, number, number][]>();
  for (let i = 0; i < B.cap; i++) {
    if (!(b[i] & 1)) continue;
    const t = b[B.texel + i], r = b[B.what + i] & 255, s = youngHeight(r, b[B.q + i]), a = crownAt(r, s), n = b[B.n + i];
    let l = filed.get(t);
    if (!l) filed.set(t, (l = []));
    l.push([i, s, a > 0 && n > Math.floor(0x7fffffff / a) ? 0x7fffffff : n * a]);
  }
  for (let i = 0; i < B.cap; i++) {
    if (!(b[i] & 1)) continue;
    const t = b[B.texel + i], r = b[B.what + i] & 255, s = youngHeight(r, b[B.q + i]), a = crownAt(r, s);
    let used = 0, larger = false;
    for (const [j, sj, room] of filed.get(t)!) {
      if (j === i || sj < s || (sj === s && j > i)) continue;
      larger = true;
      used = Math.min(used + room, 0x7fffffff);
    }
    const n = b[B.n + i];
    let keep = n;
    if (a > 0) { let fit = used < 65536 ? Math.floor((65536 - used) / a) : 0; if (!larger) fit = Math.max(fit, 1); keep = Math.min(n, fit); }
    if (keep === 0) b[i] &= ~1; else b[B.n + i] = keep;
  }
  return { bins: b, pend };
}

// ---------- staging ----------
// A scatter of stems at places in metres from the island's north-west corner, each [kind, species, x, y, height].
function scatterOf(stems: [number, number, number, number, number][]): Scatter {
  const tileOf = (s: (typeof stems)[number]) => Math.min(TILES - 1, Math.floor(s[3] / TILE_M)) * TILES + Math.min(TILES - 1, Math.floor(s[2] / TILE_M));
  const rows = [...stems].sort((a, b) => tileOf(a) - tileOf(b)), n = rows.length, start = new Int32Array(TILES * TILES + 1);
  for (const r of rows) start[tileOf(r) + 1]++;
  for (let t = 0; t < TILES * TILES; t++) start[t + 1] += start[t];
  const pos = (m: number) => Math.fround(Math.round((m / TILE_M) * 1e4) / 1e4);
  return {
    n, start, kind: Uint8Array.from(rows, (r) => r[0]), species: Uint8Array.from(rows, (r) => r[1]),
    px: Float32Array.from(rows, (r) => pos(r[2])), py: Float32Array.from(rows, (r) => pos(r[3])),
    size: Float32Array.from(rows, (r) => Math.fround(Math.round(r[4] * 1000) / 1000)), seed: Uint32Array.from(rows, (_, i) => (0x9e3779b9 * (i + 1)) >>> 0), ore: [],
  };
}
// Stems that keep as they are (no coefficients) and mast every kind every year.
const STILL: StemDay = { coef: new Int32Array(CELLS * ROWS * 2), mast: new Array(ROWS).fill(1) };
const stillStems: StemDriver = { due: () => true, tables: () => TABLES, day: () => STILL };
// Dry everywhere west of xWet metres (and all of it when none).
function dryWestOf(xWet = Infinity) {
  const out = new Uint32Array(TEXELS / 32);
  for (let t = 0; t < TEXELS; t++) if (((t % TEXELS_SIDE) + 0.5) * TEXEL_M < xWet) out[t >>> 5] |= 1 << (t & 31);
  return out;
}
type Stage = { stems: [number, number, number, number, number][]; xWet?: number; stand?: (cell: number, r: number) => number; young?: (t: number) => Int32Array; animals?: [number, number, number][]; cap?: number };
async function staged(g: Gpu, o: Stage) {
  const s = new Store(g), flora = new Flora(scatterOf(o.stems)), seeds = new Seedlings(o.cap ?? 1 << 14);
  flora.attach(s, stillStems);
  const animals = o.animals ?? [];
  s.declare({ name: "animal", capacity: 64, placed: true, still: true, fields: [{ name: "sp", type: "u32", unit: "kind", scale: 1 }] });
  if (animals.length) s.write("animal", animals.length, { x: Uint32Array.from(animals, (a) => a[0]), y: Uint32Array.from(animals, (a) => a[1]), sp: Uint32Array.from(animals, (a) => a[2]) });
  const stand = new Uint32Array(N * N * 4);
  for (let c = 0; c < N * N; c++) for (let r = 0; r < 4; r++) stand[c * 4 + r] = o.stand ? o.stand(c, r) : 0;
  const zero = new Int32Array(N * N * YOUNG_WORDS);
  const driver: SeedDriver = { law: LAW, dry: () => dryWestOf(o.xWet), stand: () => stand, young: o.young ?? (() => zero) };
  seeds.attach(s, flora, driver);
  return { s, flora, seeds, driver, P: plantLayout(s.kind(PLANT)), B: binLayout(s.kind(SEEDLING)) };
}
async function sdOf(g: Gpu, d: SeedDriver, t: number) {
  const sd = new Uint32Array(SD.dry + TEXELS / 32);
  sd.set(new Uint32Array(d.young(t).buffer), SD.young); sd.set(d.stand(), SD.stand); sd.set(d.law.browse, SD.browse); sd.set(d.dry(), SD.dry);
  return sd;
}
const pendOf = async (g: Gpu, seeds: Seedlings) => new Uint32Array(await readback(g, seeds.buffers()[0][1]));
const liveBins = (b: Uint32Array, B: BL) => { const out: number[][] = []; for (let i = 0; i < B.cap; i++) if (b[i] & 1) out.push([i, b[B.texel + i], b[B.what + i], b[B.born + i], b[B.n + i], b[B.n0 + i], b[B.q + i], b[B.peak + i]]); return out; };
// The seed in the soil as [layer, texel, count] for every texel holding any.
const held = (p: Uint32Array) => { const out: number[][] = []; for (let i = 0; i < p.length; i++) if (p[i]) out.push([Math.floor(i / NT), i % NT, p[i]]); return out; };

// ---------- the oracle against the GPU ----------
// A pine, oak, ash and bramble wood on a coast, with deer and rabbits in it, under random coefficients by cell: its
// pine's shed and coming up, its brambles' seedlings, a suckering stump, oak's and ash's autumn sheds, and every bin's
// day after, each day equal to the oracle's.
async function oracleRun(g: Gpu) {
  let seed = 11;
  const rand = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  const x0 = 120 * CELL, stems: [number, number, number, number, number][] = [];
  const kinds: [number, number, number][] = [[K("tree"), S("pine"), 18], [K("tree"), S("oak"), 22], [K("tree"), S("ash"), 24], [K("bush"), S("berry"), 1.2]];
  for (let k = 0; k < 60; k++) {
    const [kind, sp, h] = kinds[k % 4];
    stems.push([kind, sp, x0 + rand() * 120, x0 + rand() * 120, h + Math.floor(rand() * 4)]);
  }
  // a closed stand of tall oaks over a few texels inside it
  for (let k = 0; k < 40; k++) stems.push([K("tree"), S("oak"), x0 + 30 + (k % 8) * 2, x0 + 30 + Math.floor(k / 8) * 2, 30]);
  const youngs = new Map<number, Int32Array>();
  const young = (t: number) => {
    let y = youngs.get(t);
    if (!y) {
      y = new Int32Array(N * N * YOUNG_WORDS);
      for (let c = 0; c < N * N; c++) {
        if (Math.abs((c % N) - 122) > 6 || Math.abs(Math.floor(c / N) - 122) > 6) continue;
        for (let r = 0; r < 5; r++) {
          const w = c * YOUNG_WORDS + r * 4;
          y[w] = Math.floor(rand() * 9000); y[w + 1] = Math.floor(rand() * 1500); y[w + 2] = Math.floor(rand() * 9000); y[w + 3] = Math.floor(rand() * 1500);
        }
      }
      youngs.set(t, y);
    }
    return y;
  };
  const animals: [number, number, number][] = [];
  for (let k = 0; k < 30; k++) animals.push([Math.round((x0 + rand() * 300) * 1000), Math.round((x0 + rand() * 300) * 1000), k % 3]);
  const { s, flora, seeds, driver, P } = await staged(g, { stems, xWet: x0 + 100, young, animals, stand: () => 0 });
  let B = binLayout(s.kind(SEEDLING));
  const bodies: Uint32Array[] = [], all: number[][] = [];
  const days = [...Array.from({ length: 9 }, (_, k) => 6 + k), 25, 26, 27, 28, 29, 30];
  for (const day of days) {
    const pre = await s.read(PLANT, "body"), pend = await pendOf(g, seeds);
    let bins = await s.read(SEEDLING, "body"), alloc = await s.read(SEEDLING, "alloc");
    const requests = day === 10 ? [Math.round((x0 + 50) * 1000), Math.round((x0 + 60) * 1000), 0xabcdef] : [];
    if (requests.length) seeds.sucker(requests[0], requests[1], requests[2]);
    await s.step(day);
    // a room the law grew before its day: the bins and allocation as they were, laid out in it (store.ts grow)
    const now = binLayout(s.kind(SEEDLING));
    if (now.cap !== B.cap) {
      const cols = bins.length / B.cap, to = new Uint32Array(cols * now.cap), al = new Uint32Array(CTL_WORDS + now.cap);
      for (let c = 0; c < cols; c++) to.set(bins.subarray(c * B.cap, (c + 1) * B.cap), c * now.cap);
      al.set(alloc);
      [bins, alloc, B] = [to, al, now];
    }
    const post = await s.read(PLANT, "body"), sd = await sdOf(g, driver, day);
    const want = oracleDay(P, B, { day, pre, post, bins, alloc, pend, sd, animals, requests });
    const got = await s.read(SEEDLING, "body");
    expect(liveBins(got, B)).toEqual(liveBins(want.bins, B));
    expect(got).toEqual(want.bins);
    expect(held(await pendOf(g, seeds))).toEqual(held(want.pend));
    // the census is the bins'
    const c = seeds.census!;
    for (let r = 0; r < 5; r++) {
      const live = liveBins(got, B).filter((v) => (v[2] & 255) === r);
      expect(c.bins[r]).toBe(live.length);
      expect(c.members[r]).toBe(live.reduce((a, v) => a + v[4], 0));
    }
    bodies.push(got);
    all.push(...liveBins(got, B));
  }
  seeds.destroy(); flora.destroy(); s.destroy();
  return { bodies, all };
}

test("a law day of seeds and seedlings on the GPU equals the oracle's bit for bit, on the high-performance and the low-power adapter alike", async () => {
  // no deer or rabbits, no browsing
  expect([LAW.browse[0], LAW.browse[1024]]).toEqual([0, 0]);
  const a = await oracleRun(await theGpu());
  // pine, aspen's suckers and brambles came up (ash's and oak's only in springs to come), and some bins were browsed or
  // thinned below what came up
  const rows = new Set(a.all.map((v) => v[2] & 255));
  for (const r of [0, 3, 4]) expect(rows.has(r)).toBe(true);
  expect(a.all.some((v) => v[4] < v[5])).toBe(true);
  const low = await openGpu("low-power"), b = await oracleRun(low);
  expect(b.bodies).toEqual(a.bodies);
  low.device.destroy();
}, 600_000);

// ---------- the plan's checks ----------
// Where every one of a parent's n seeds lands, by the kernel the shed uses, as distances in m.
async function landings(g: Gpu, sp: "pine" | "ash", h: number, n: number) {
  const x = 128 * CELL, { s, flora, seeds, driver, P } = await staged(g, { stems: [[K("tree"), S(sp), x, x, h]] });
  const out = storage(g, 8 * n), sd = storage(g, await sdOf(g, driver, 0));
  s.run(seedLandings(P, LAW), [s.kind(PLANT).body, sd, out], cover(g, n), [0, sp === "pine" ? 0 : 2, 0, n]);
  s.flush();
  const o = new Uint32Array(await readback(g, out));
  const body = await s.read(PLANT, "body"), mixi = mix(body[0] >>> 1), dry = dryWestOf();
  // the oracle's, for every seed
  for (let k = 0; k < n; k += 97) {
    rinit(mixi, STREAM.land, 0, k);
    const d = reach(sp === "pine" ? 0 : 2, body[P.size]);
    expect([o[2 * k], o[2 * k + 1]]).toEqual([d, landing(dry, body[P.x], body[P.y], d)]);
  }
  out.destroy(); sd.destroy(); seeds.destroy(); flora.destroy(); s.destroy();
  return Array.from({ length: n }, (_, k) => o[2 * k] / 1000);
}

test("one pine's seed lands with 80% inside one tree height; one ash's at the cited kernel mean", async () => {
  const g = await theGpu();
  // a 20 m pine's year of seed (R455: 80% within 20 m of a 20 m tree)
  const pine = await landings(g, "pine", 20, 12000), within = pine.filter((d) => d <= 20).length / pine.length;
  console.log(`pine: ${(within * 100).toFixed(1)}% of 12,000 seeds within the tree's 20 m`);
  expect(Math.abs(within - 0.8)).toBeLessThan(3 * Math.sqrt((0.8 * 0.2) / 12000));
  // an ash's mast (R459: mean 39.1 m)
  const ash = await landings(g, "ash", 25, 140000), mean = ash.reduce((a, d) => a + d, 0) / ash.length;
  const sdv = Math.sqrt(ash.reduce((a, d) => a + (d - mean) ** 2, 0) / ash.length);
  console.log(`ash: mean ${mean.toFixed(2)} m over 140,000 fruits (sd ${sdv.toFixed(1)})`);
  expect(Math.abs(mean - 39.1)).toBeLessThan(3 * (sdv / Math.sqrt(ash.length)) + 0.05);
}, 300_000);

// The streamed shed of a parent's year against each of its seeds as an active object of a kind of its own, stepped
// day by day through the window.
async function streamedAndActive(g: Gpu, killOn: number | null) {
  const x = 140 * CELL, run = async (active: boolean) => {
    const { s, flora, seeds, driver, P } = await staged(g, { stems: [[K("tree"), S("pine"), x, x, 20], [K("tree"), S("pine"), x + 400, x, 20]] });
    const ly = LAW.layers[LAYER.pine], seedKind = active ? s.declare({ name: "seed", capacity: 32768, fields: ["parent", "pgen", "k", "texel"].map((name) => ({ name, type: "u32" as const, unit: "", scale: 1 })) }) : null;
    // the stems' law sets each parent's crop the first day; the seeds are born from it then, each on its tree
    await s.step(ly.from - 1);
    if (seedKind) {
      const body = await s.read(PLANT, "body"), cnt = storage(g, 4 * P.cap), counts = new Uint32Array(P.cap);
      for (let i = 0; i < P.cap; i++) if (body[i] & 1) counts[i] = body[P.crop + i];
      g.device.queue.writeBuffer(cnt, 0, counts);
      s.births(PLANT, "seed", cnt, `child_set_parent(slot, parent); child_set_pgen(slot, parent_gen(parent)); child_set_k(slot, k); child_set_texel(slot, ${ON_TREE}u);`);
      s.flush();
      cnt.destroy();
    }
    const sk = seedKind && { cap: seedKind.capacity, parent: at(seedKind, "parent"), pgen: at(seedKind, "pgen"), k: at(seedKind, "k"), texel: at(seedKind, "texel") };
    const sd = storage(g, await sdOf(g, driver, 0));
    let pend: Uint32Array | null = null;
    for (let day = ly.from; day < ly.to; day++) {
      if (killOn === day) flora.change(flora.entry(0), null);
      if (sk) {
        await s.step(day);
        s.run(seedStep(P, sk, LAW), [seedKind!.body, s.kind(PLANT).body, sd], cover(g, sk.cap), [0, 0, day - ly.from, ly.to - ly.from]);
        s.flush();
      } else await s.step(day);
      if (day === ly.to - 1 && !sk) pend = (await pendOf(g, seeds)).slice(0, NT);
    }
    let counts = pend;
    if (sk) {
      const b = await s.read("seed", "body");
      counts = new Uint32Array(NT);
      for (let j = 0; j < sk.cap; j++) if (b[j] & 1 && b[sk.texel + j] < NT) counts[b[sk.texel + j]]++;
    }
    sd.destroy(); seeds.destroy(); flora.destroy(); s.destroy();
    return counts!;
  };
  return { streamed: await run(false), active: await run(true) };
}

test("the streamed evaluation of a parent's year of seed gives exactly the survivors that stepping each seed as an active object would", async () => {
  const g = await theGpu(), { streamed, active } = await streamedAndActive(g, null);
  let n = 0;
  for (let t = 0; t < NT; t++) n += streamed[t];
  console.log(`two pines' year of 24,000 seeds: ${n} live to come up (${((100 * n) / 24000).toFixed(2)}%, the law's ${(100 * LAW.survive[0] / 2 ** 32).toFixed(2)}%)`);
  expect(n).toBeGreaterThan(0);
  expect(active).toEqual(streamed);
}, 300_000);

test("seed on water or under full crowns follows the emergence rules, and a parent's death stops its shed", async () => {
  const g = await theGpu();
  // a parent killed on the shed's third day sheds only its first two days' blocks, streamed or active alike
  const whole = await streamedAndActive(g, null), cut = await streamedAndActive(g, LAW.layers[LAYER.pine].from + 2);
  expect(cut.active).toEqual(cut.streamed);
  const sum = (a: Uint32Array, x0: number, x1: number) => { let n = 0; for (let t = 0; t < NT; t++) { const x = (t % TEXELS_SIDE) * TEXEL_M; if (x >= x0 && x < x1) n += a[t]; } return n; };
  const x = 140 * CELL, window = LAW.layers[LAYER.pine].to - LAW.layers[LAYER.pine].from;
  const killed = sum(cut.streamed, x - 200, x + 200), kept = sum(cut.streamed, x + 200, x + 600);
  console.log(`a pine killed on day 3 of ${window}: ${killed} of its seed live to come up against ${sum(whole.streamed, x - 200, x + 200)} had it stood; its neighbour ${kept}`);
  expect(kept).toBe(sum(whole.streamed, x + 200, x + 600));
  expect(killed).toBeGreaterThan(0);
  expect(killed).toBeLessThan(sum(whole.streamed, x - 200, x + 200));
  // a pine on the shore and an ash under a closed oak stand: their seed comes up only on dry ground, and the pine's
  // only where the crowns leave 60% of the light
  const x0 = 100 * CELL, stems: [number, number, number, number, number][] = [[K("tree"), S("pine"), x0 + 90, x0, 20], [K("tree"), S("ash"), x0, x0 + 300, 35]];
  for (let k = 0; k < 64; k++) stems.push([K("tree"), S("oak"), x0 - 20 + (k % 8) * 5, x0 + 280 + Math.floor(k / 8) * 5, 30]);
  // three pines just east of the oaks' texels, whose seed blows in under them
  for (let k = 0; k < 3; k++) stems.push([K("tree"), S("pine"), x0 + 25 + k * 5, x0 + 303, 20]);
  const { s, seeds, flora } = await staged(g, { stems, xWet: x0 + 100 });
  const ly = LAW.layers[LAYER.pine];
  for (let day = ly.from; day < ly.to; day++) await s.step(day);
  const pend = await pendOf(g, seeds), raster = rasterOf(await s.read(PLANT, "body"), plantLayout(s.kind(PLANT)));
  let wet = 0, shaded = 0;
  for (let t = 0; t < NT; t++) {
    const xm = ((t % TEXELS_SIDE) + 0.5) * TEXEL_M;
    if (xm >= x0 + 100) wet += pend[LAYER.pine * NT + t];
    if (pend[LAYER.pine * NT + t] && lightAt(raster, t, 0) < LAW.pineLight) shaded++;
  }
  expect(wet).toBe(0);
  // the shore pine's seed that lived but fell on the water, by the oracle
  const plant = await s.read(PLANT, "body"), PL = plantLayout(s.kind(PLANT)), everywhere = dryWestOf();
  let lost = 0;
  for (let i = 0; i < PL.cap; i++) {
    if (!(plant[i] & 1) || plant[PL.x + i] !== Math.round((x0 + 90) * 1000)) continue;
    const m = mix(plant[i] >>> 1), c = plant[PL.crop + i];
    for (let k = 0; k < c; k++) {
      if (philox([i, k >>> 2, 0, 0], [m, STREAM.surv])[k & 3] >= LAW.survive[0]) continue;
      rinit(m, STREAM.land, i, k);
      const t = landing(everywhere, plant[PL.x + i], plant[PL.y + i], reach(0, plant[PL.size + i]));
      if (t < NT && ((t % TEXELS_SIDE) + 0.5) * TEXEL_M >= x0 + 100) lost++;
    }
  }
  expect(lost).toBeGreaterThan(0);
  console.log(`the shore pine's seed: ${lost} lived but fell on the water`);
  expect(shaded).toBeGreaterThan(0);
  await s.step(ly.up);
  const bins = liveBins(await s.read(SEEDLING, "body"), binLayout(s.kind(SEEDLING)));
  const pineBins = bins.filter((v) => (v[2] & 255) === 0);
  expect(pineBins.length).toBeGreaterThan(0);
  for (const v of pineBins) expect(lightAt(raster, v[1], 0)).toBeGreaterThanOrEqual(LAW.pineLight);
  for (const v of bins) expect(((t: number) => ((t % TEXELS_SIDE) + 0.5) * TEXEL_M)(v[1])).toBeLessThan(x0 + 100);
  console.log(`a shore pine and pines in an oak wood: ${pineBins.length} pine bins come up, none on water, none of ${shaded} texels the crowns shade past 40%`);
  seeds.destroy(); flora.destroy(); s.destroy();
  // ash comes up under the closed crowns, after two winters
  const ash = await staged(g, { stems: stems.slice(1) });
  const al = LAW.layers[LAYER.ash0];
  for (let day = al.from; day < al.to; day++) await ash.s.step(day);
  const ashPend = await pendOf(g, ash.seeds);
  let under = 0;
  const araster = rasterOf(await ash.s.read(PLANT, "body"), plantLayout(ash.s.kind(PLANT)));
  for (let t = 0; t < NT; t++) if (ashPend[LAYER.ash0 * NT + t] && lightAt(araster, t, 0) < 0.1 * 65536) under += ashPend[LAYER.ash0 * NT + t];
  await ash.s.step(2 * LAW.yearDays + al.up);
  const ashBins = liveBins(await ash.s.read(SEEDLING, "body"), binLayout(ash.s.kind(SEEDLING))).filter((v) => (v[2] & 255) === 2 && lightAt(araster, v[1], 0) < 0.1 * 65536);
  console.log(`ash: ${under} fruits live to come up under crowns letting through under 10%; ${ashBins.length} bins of them come up two springs on`);
  expect(under).toBeGreaterThan(0);
  expect(ashBins.length).toBeGreaterThan(0);
  ash.seeds.destroy(); ash.flora.destroy(); ash.s.destroy();
}, 600_000);

test("young trees as tall as their stand stand up as stems the next day, each where its identity puts it in its texel", async () => {
  const g = await theGpu(), x0 = 160 * CELL;
  // brambles' seedlings in the open, and pines' that grow fast and stand up at 5 cm
  const young = () => {
    const y = new Int32Array(N * N * YOUNG_WORDS);
    for (let c = 0; c < N * N; c++) for (let r = 0; r < 5; r++) { y[c * YOUNG_WORDS + r * 4] = 30000; y[c * YOUNG_WORDS + r * 4 + 2] = 30000; }
    return y;
  };
  const { s, seeds, flora, P } = await staged(g, { stems: [[K("tree"), S("pine"), x0, x0, 20]], young, stand: (_, r) => (r === 0 ? 50 : 0) });
  const ly = LAW.layers[LAYER.pine];
  for (let day = ly.from; day <= ly.up; day++) await s.step(day);
  let bins = liveBins(await s.read(SEEDLING, "body"), binLayout(s.kind(SEEDLING)));
  const before = (await s.read(PLANT, "body")).reduce((n, w, i) => n + (i < P.cap ? w & 1 : 0), 0);
  // grow until marked, then one more day
  let day = ly.up + 1;
  for (; day < ly.up + 60 && !bins.some((v) => v[2] & GRAD); day++) { await s.step(day); bins = liveBins(await s.read(SEEDLING, "body"), binLayout(s.kind(SEEDLING))); }
  const marked = bins.filter((v) => v[2] & GRAD), members = marked.reduce((a, v) => a + v[4], 0);
  expect(marked.length).toBeGreaterThan(0);
  await s.step(day);
  const body = await s.read(PLANT, "body"), born: [number, number, number, number][] = [];
  for (let i = 1; i < P.cap; i++) if (body[i] & 1) born.push([body[P.x + i], body[P.y + i], body[P.size + i], body[P.what + i]]);
  expect(born.length + 1).toBe(before + members);
  // the oracle's places and heights
  const want: [number, number, number, number][] = [];
  const after = await s.read(SEEDLING, "body");
  for (const [i, t, , bornDay, n, n0, q] of marked) {
    const m = mix(after[i] >>> 1);
    for (let k = 0; k < n; k++) {
      const e = feistel(k, n0, fkeys(m, STREAM.ident, i, bornDay));
      rinit(m, STREAM.place, i, e);
      const x = (t % TEXELS_SIDE) * TEXEL_MM + unif(TEXEL_MM), y = Math.floor(t / TEXELS_SIDE) * TEXEL_MM + unif(TEXEL_MM);
      want.push([x, y, heightAt(0, q), K("tree") + 256 * S("pine")]);
    }
  }
  const order = (a: number[], b: number[]) => a[0] - b[0] || a[1] - b[1];
  expect(born.sort(order)).toEqual(want.sort(order));
  for (const [i] of marked) expect(after[i] & 1).toBe(0);
  console.log(`${marked.length} pine bins stood up as ${members} stems`);
  seeds.destroy(); flora.destroy(); s.destroy();
}, 300_000);

// ---------- seed 1 ----------
test("seed 1's seedlings over seven island years: pine within 50 m of its wood, oak in old fields, and the memory they take", async () => {
  const w = newWorld(1);
  await resident(w, stemDriver(w), seedDriver(w));
  await residentAnimals(w);
  const s = heldStore(w)!, seeds = seedlingsOf(w)!, dry = seedDriver(w).dry(), years = 7;
  const t0 = Math.ceil(w.t / DAY) * DAY, ms: number[] = [], P = plantLayout(s.kind(PLANT));
  const ha = (TEXEL_M * TEXEL_M) / 1e4;
  // seedlings a ha of a kind in the open (the crowns leaving 60% of the light) or under crowns, in texels within dm
  // metres of a stem of a kind (centre to stem), from the stems and bins as they stand
  const measure = async (label: string) => {
    const plant = await s.read(PLANT, "body"), bins = await s.read(SEEDLING, "body"), raster = rasterOf(plant, P), B = binLayout(s.kind(SEEDLING));
    const byKind = [new Float64Array(NT), new Float64Array(NT)];
    for (let i = 0; i < B.cap; i++) if (bins[i] & 1 && (bins[B.what + i] & 255) <= 1) byKind[bins[B.what + i] & 255][bins[B.texel + i]] += bins[B.n + i];
    const near = (sp: "pine" | "oak", dm: number) => {
      const out = new Uint8Array(NT), r = Math.ceil(dm / TEXEL_M);
      for (let i = 0; i < P.cap; i++) {
        if (!(plant[i] & 1) || plant[P.what + i] !== K("tree") + 256 * S(sp)) continue;
        const tx = Math.floor(plant[P.x + i] / TEXEL_MM), ty = Math.floor(plant[P.y + i] / TEXEL_MM);
        for (let y = Math.max(0, ty - r); y <= Math.min(TEXELS_SIDE - 1, ty + r); y++) for (let x = Math.max(0, tx - r); x <= Math.min(TEXELS_SIDE - 1, tx + r); x++)
          if (Math.hypot((x + 0.5) * TEXEL_MM - plant[P.x + i], (y + 0.5) * TEXEL_MM - plant[P.y + i]) <= dm * 1000) out[y * TEXELS_SIDE + x] = 1;
      }
      return out;
    };
    const density = (k: number, mask: Uint8Array, open: boolean) => {
      let n = 0, a = 0;
      for (let t = 0; t < NT; t++) {
        if (!mask[t] || !((dry[t >>> 5] >>> (t & 31)) & 1) || open !== lightAt(raster, t, 0) >= LAW.pineLight) continue;
        n += byKind[k][t]; a += ha;
      }
      return `${a ? (n / a).toFixed(0) : "-"} a ha over ${a.toFixed(0)} ha`;
    };
    const pine = near("pine", 50), oak = near("oak", 100);
    console.log(`${label}: pine within 50 m of a pine, open ${density(0, pine, true)}, under crowns ${density(0, pine, false)}; oak within 100 m of an oak, open ${density(1, oak, true)}, under crowns ${density(1, oak, false)}`);
  };
  // each law day, and the ticks after it that shed the day's seed (the world's other ticks run no law of theirs)
  const slice: number[] = [];
  for (let d = 0; d <= years * YEAR_DAYS; d++) {
    let a = performance.now();
    await s.step(t0 + d * DAY);
    ms.push(performance.now() - a);
    for (let j = 1; seeds.shedding; j++) { a = performance.now(); await s.step(t0 + d * DAY + j); slice.push(performance.now() - a); }
    const c = seeds.census!;
    if (d % 10 === 0 || c.pend.some((v) => v > 0)) console.log(`day ${d}: bins ${c.bins.join(", ")}; members ${c.members.join(", ")}; in the soil ${c.pend.join(", ")}; ${ms[ms.length - 1].toFixed(0)} ms`);
    if (d > 0 && d % YEAR_DAYS === 0) await measure(`end of year ${d / YEAR_DAYS}`);
  }
  // the memory the seedlings take: the bins, the seed in the soil, their drivers and the shed's parents, and the
  // store scratch of the thinning's filing, the coming up and the standing up
  const kind = s.kind(SEEDLING), plantCap = s.kind(PLANT).capacity, MB = 2 ** 20;
  const bins = ((kind.fields.length + 1) * kind.capacity + CTL_WORDS + kind.capacity) * 4;
  const own = seeds.bytes(), scratch = (3 * kind.capacity + 3 * NT + kind.capacity + plantCap) * 4;
  const q = (a: number[], p: number) => { const v = [...a].sort((x, y) => x - y); return v.length ? v[Math.min(v.length - 1, Math.floor(v.length * p))].toFixed(0) : "-"; };
  console.log(`seedlings: bins ${(bins / MB).toFixed(0)} MB, seed in the soil, drivers and parents ${(own / MB).toFixed(0)} MB, scratch ${(scratch / MB).toFixed(0)} MB, total ${((bins + own + scratch) / MB).toFixed(0)} MB`);
  console.log(`a law day (the stems', the seedlings', the hour's deadwood and animals): p50 ${q(ms, 0.5)} ms, p95 ${q(ms, 0.95)}, max ${q(ms, 1)}; a shed slice tick p50 ${q(slice, 0.5)}, max ${q(slice, 1)} over ${slice.length}`);
  expect(seeds.census!.bins.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(kind.capacity);
}, 3_600_000);
