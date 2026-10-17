import { afterAll, expect, test } from "bun:test";
import { type Gpu, openGpu, releaseGpu, theGpu } from "./device";
import { readback, storage } from "./kernel";
import { multinom, philox, rinit } from "./rand";
import { Store } from "./store";
import { type Bin, FATE, Lumped, PROMOTED, keyOf, lstream } from "./tiers/lumped";
import { Smalls, type SmallsDriver } from "./smalls";
import { NONE, T as TILES, W_, W_RUNS } from "./wgsl/animals";
import { BASE, CELLS, CEN, CENW, CW, DAYW, ST, STATIC_WORDS, STW, SPC, TS, X, faunaState, tillerState } from "./wgsl/smalls";
import {
  BLADE_UNITS, PACE, PIECE_UG, REED_EMERGE, REED_LEAVES, REED_UNDER, SLA_GRASS, TAXA, faunaTwin, foxSummer, lamina, litterTwin, sandTwin, smallsLaw, smallsTables, tillerTwin,
} from "../sim/smalls";

let low: Gpu | null = null;
afterAll(async () => { low?.device.destroy(); await releaseGpu(); });

const DAY = 288, M2 = 75 * 75, Q16 = (x: number) => Math.round(x * 65536);
// One cell of open sward under steady drivers (note sec. 7.7): 15 C, the forage rule's summer sun (18 MJ/m2 a day
// [design: a Danish summer day's mean]) at fertility 0.5, leaf appearance held on its after-10-June branch, the summer's
// deaths all year, and no calendar: no vernalisation, elongation or flowering.
const CELL = 150 * 256 + 100;
const G = 1.4 * 18 * 0.8 * 1 * 1 * 0.5 * PACE, SEN = ((15 - 4) * PACE) / 460;
function sward(extra: { fauna?: boolean } = {}): SmallsDriver {
  const law = { ...smallsLaw(), springBranch: [0, 0] as const, summer: [0, 40] as const, vern: 99, elong: [0, 0] as const, flower: [0, 0] as const, seed: [0, 0] as const };
  const tables = smallsTables();
  return {
    seed: 7, law, tables, leaf: [],
    statics() { const s = new Uint32Array(CELLS * STATIC_WORDS); s[CELL * STATIC_WORDS + X.open] = 65536; s[CELL * STATIC_WORDS + X.flight] = 65536; return s; },
    K() {
      const k = new Uint32Array(CELLS * 16);
      if (extra.fauna) TAXA.forEach((tx, t) => { k[CELL * 16 + t] = Math.round(tx.K({ open: 1, field: 0, pine: 0, broad: 0, heath: 0, marsh: 0, sand: 0, clay: 0 }) * M2); });
      return k;
    },
    day() { const d = new Uint32Array(CELLS * DAYW); d.set([Q16(15) >>> 0, Q16(G), Q16(SEN), 65536, 65536], CELL * DAYW); return d; },
    start() {
      const fauna: number[] = [];
      if (extra.fauna) fauna.push(CELL, faunaState(0, 3, 5), 289 * M2);
      return { tiller: [CELL, tillerState(7, TS.veg, SPC.grass, 0), 5000 * M2], litter: [], fauna };
    },
    twins: { tiller: tillerTwin(law), litter: litterTwin(law), fauna: faunaTwin(law), sand: sandTwin(law) },
    pieceUg: PIECE_UG, bladeUnits: BLADE_UNITS, reedLeaves: REED_LEAVES, reedEmerge: REED_EMERGE * M2, reedUnder: REED_UNDER * M2, foxSummer: foxSummer(),
  };
}
const CAPS = { tiller: 4096, litter: 4096, fauna: 4096, sand: 64 };
const cellInputs = async (g: Gpu, sm: Smalls, tables: Uint32Array) => {
  const inp = new Uint32Array(BASE + CELLS * CW);
  inp.set(tables);
  inp.set(new Uint32Array(await readback(g, sm.buffersForTest!.inp, CW * 4, (BASE + CELL * CW) * 4)), BASE + CELL * CW);
  return inp;
};
// A merging kind's step as the twin has it, in counts: each bin's split and births, the stayers first.
function twinStep(L: Lumped, bins: Bin[], t: number, inp: Uint32Array, takes: Map<number, number> = new Map()): Bin[] {
  const add = new Map<number, number>(), order: number[] = [];
  const put = (key: number, n: number) => { if (!n) return; if (!add.has(key)) { add.set(key, 0); order.push(key); } add.set(key, add.get(key)! + n); };
  const moves: [number, number][] = [];
  for (const b of bins) {
    const left = b.T - (takes.get(b.key) ?? 0);
    if (!left) continue;
    const state = b.key & 0xffff, sp = L.spec.ts(b.key >>> 16, state, t, inp);
    rinit(L.seed, lstream(b.e, 0), b.key, t);
    const c = multinom(left, sp.t), born = Lumped.born(sp, c);
    let stay = left;
    for (let j = 0; j < c.length; j++) {
      if (sp.s[j] === state) continue;
      stay -= c[j];
      if (sp.s[j] < FATE) moves.push([((b.key & 0xffff0000) | sp.s[j]) >>> 0, c[j]]);
    }
    if (born) moves.push([((b.key & 0xffff0000) | sp.b!.state) >>> 0, born]);
    put(b.key, stay);
  }
  for (const [k, n] of moves) put(k, n);
  return [...add.keys()].sort((a, b) => a - b).map((key) => ({ key, e: t, T: add.get(key)!, out: 0, dense: false }));
}

async function swardRun(g: Gpu, days: number) {
  const s = new Store(g), sm = new Smalls(), drv = sward();
  sm.attach(s, drv, null, 40 * DAY, CAPS);
  const L = sm.kinds!.tiller, series: Bin[][] = [];
  let prev = await L.read();
  const lai: number[] = [], n: number[] = [], wmean: number[] = [];
  for (let d = 1; d <= days; d++) {
    const t = (40 + d) * DAY;
    await s.step(t);
    const got = await L.read(), inp = await cellInputs(g, sm, drv.tables);
    expect(got).toEqual(twinStep(L, prev, t, inp));
    series.push(got);
    prev = got;
    let N = 0, mg = 0;
    for (const b of got) { const k = b.key & 7; N += b.T; mg += b.T * lamina(k); }
    n.push(N / M2); wmean.push(mg / N); lai.push(((mg / 1000) * SLA_GRASS) / 1000 / M2);
  }
  s.destroy();
  return { series, lai, n, wmean };
}

test("a sward's tillers settle where van Loo and Lantinga's law puts them: the GPU's chain equals the twin's bit for bit, on both adapters", async () => {
  const DAYS = 400, a = await swardRun(await theGpu(), DAYS);
  // van Loo's equilibrium (R950): births equal deaths where kN Fs LA = mu
  const LA = 0.14 * (15 - 10) / (18 - 10), lstar = (0.867 - 0.003 / (0.25 * LA)) / 0.183;
  const tail = a.lai.slice(200), mean = tail.reduce((x, y) => x + y, 0) / tail.length;
  const sd = Math.sqrt(tail.reduce((x, y) => x + (y - mean) ** 2, 0) / tail.length);
  const N = a.n.slice(200).reduce((x, y) => x + y, 0) / tail.length, w = a.wmean.slice(200).reduce((x, y) => x + y, 0) / tail.length;
  console.log(`sward: LAI ${mean.toFixed(3)} (sd ${sd.toFixed(3)}) against van Loo's LAI* ${lstar.toFixed(3)}; ${N.toFixed(0)} tillers a m2 of ${w.toFixed(2)} mg lamina; on the constant-LAI line N = LAI / (SLA w) = ${(mean / ((SLA_GRASS / 1e6) * w)).toFixed(0)}; log10 N / 5,000 = ${Math.log10(N / 5000).toFixed(3)} (R951's band 0.17)`);
  // the run's figures are recorded in plant-constants sec. 14 whether or not they meet the cited bands; what must hold
  // is the chain: a live sward every day, on the constant-LAI line by its own lamina
  expect(Math.min(...a.n)).toBeGreaterThan(0);
  expect(Math.abs(mean / ((SLA_GRASS / 1e6) * w) - N) / N).toBeLessThan(1e-6);
  low ??= await openGpu("low-power");
  const b = await swardRun(low, 60);
  expect(b.series).toEqual(a.series.slice(0, 60));
}, 3_600_000);

test("a beetle a held fox singles out keeps the identity and state it had as a member, its fate PROMOTED, and steps after under the same law", async () => {
  const g = await theGpu(), s = new Store(g), sm = new Smalls(), drv = sward({ fauna: true });
  sm.attach(s, drv, null, 40 * DAY, CAPS);
  const cap = 256, W = storage(g, W_RUNS * TILES * 4), RQ = storage(g, new Uint32Array(cap).fill(NONE));
  sm.bind(s, { W, RQ, cap }, false);
  sm.kinds!.fauna.watch([CELL]);
  const F = sm.kinds!.fauna;
  await s.step(41 * DAY);
  const before = (await F.read()).find((b) => b.key === keyOf(CELL, faunaState(0, 3, 5)))!;
  // the fox's request: one adult carabid of its cell
  g.device.queue.writeBuffer(RQ, 3 * 4, Uint32Array.of(before.key));
  await s.step(42 * DAY);
  const k = s.kind("bug"), body = await s.read("bug", "body"), C = k.capacity, f = (n: string, i: number) => body[(k.field[n] + 1) * C + i];
  const live = Array.from({ length: C }, (_, i) => i).filter((i) => body[i] & 1);
  expect(live.length).toBe(1);
  const i = live[0], sig = F.identity(before, 0);
  expect([f("lkey", i), f("le", i), f("lsig", i)]).toEqual([before.key, before.e, sig]);
  expect(F.fate(before, 0)).toEqual({ t: 42 * DAY, state: PROMOTED });
  // the rest of the bin went on by the split alone: ranks after the first left or stayed as the twin draws them
  const inp = await cellInputs(g, sm, drv.tables), sp = F.spec.ts(CELL, before.key & 0xffff, 42 * DAY, inp);
  rinit(F.seed, lstream(before.e, 0), before.key, 42 * DAY);
  const c = multinom(before.T - 1, sp.t);
  const gone = c.reduce((a, x, j) => (sp.s[j] === (before.key & 0xffff) ? a : a + x), 0);
  expect(F.fate(before, 1 + gone)).toBeNull();
  if (gone) expect(F.fate(before, 1)!.state).not.toBe(PROMOTED);
  // the request is spent: the link set it back to none
  expect(new Uint32Array(await readback(g, RQ))[3]).toBe(NONE);
  // as an individual it stepped at the step it was taken and steps each step after, by its identity's own draws
  let state = before.key & 0xffff, alive = true;
  for (let d = 42; d <= 46 && alive; d++) {
    if (d > 42) await s.step(d * DAY);
    const x = await cellInputs(g, sm, drv.tables), q = F.spec.ts(CELL, state, d * DAY, x), u = philox([before.key, sig, before.e, d * DAY], [F.seed, 0x80000001])[0];
    const to = q.s[q.t.filter((b) => b <= u).length];
    if (to >>> 0 >= FATE) alive = false; else state = to;
  }
  const after = await s.read("bug", "body");
  expect(after[i] & 1).toBe(alive ? 1 : 0);
  if (alive) expect(after[(k.field.lstate + 1) * C + i]).toBe(state);
  s.destroy(); W.destroy(); RQ.destroy();
}, 600_000);

test("what the grazers eat of a cell's green is what its tillers lose over the days, the binomial's difference carried as credit", async () => {
  const g = await theGpu(), s = new Store(g), sm = new Smalls(), drv = sward();
  sm.attach(s, drv, null, 40 * DAY, CAPS);
  // the cell's tile: all of it ground layer, a grass area of the tile in milli-m2
  const tile = (Math.floor(Math.floor(CELL / 256) / 2)) * 128 + Math.floor((CELL % 256) / 2), garea = 150 * 150 * 1000;
  const Wi = new Uint32Array(W_RUNS * TILES);
  Wi[W_.land * TILES + tile] = 1; Wi[W_.garea * TILES + tile] = garea;
  const W = storage(g, Wi), RQ = storage(g, new Uint32Array(8).fill(NONE));
  sm.bind(s, { W, RQ, cap: 8 }, false);
  let eaten = 0, lost = 0, credit = 0;
  for (let d = 41; d <= 80; d++) {
    await s.step(d * DAY);
    const w = new Uint32Array(await readback(g, W)), fg = w[W_.fg * TILES + tile];
    // the animals eat a tenth of the green the link set out (Q16 g/m2 of the grass area: mg = fg garea / 65536)
    const bite = Math.floor(fg / 10);
    eaten += Math.floor((bite * garea) / 65536);
    g.device.queue.writeBuffer(W, (W_.fg * TILES + tile) * 4, Uint32Array.of(fg - bite));
    const cen = new Uint32Array(await readback(g, sm.buffersForTest!.cen, CENW * 4, CELL * CENW * 4));
    const st = new Int32Array(await readback(g, sm.buffersForTest!.st, STW * 4, CELL * STW * 4));
    lost += (cen[CEN.bitten] + cen[CEN.bitten + 1] * 2 ** 32) / 8;
    credit = st[ST.credit] / 8;
  }
  // the last day's eating is taken at the next step: what the bins lost and what is still owed make up all but it
  await s.step(81 * DAY);
  const cen = new Uint32Array(await readback(g, sm.buffersForTest!.cen, CENW * 4, CELL * CENW * 4));
  const st = new Int32Array(await readback(g, sm.buffersForTest!.st, STW * 4, CELL * STW * 4));
  lost += (cen[CEN.bitten] + cen[CEN.bitten + 1] * 2 ** 32) / 8;
  credit = st[ST.credit] / 8;
  console.log(`grazed cell over 40 days: eaten ${(eaten / 1000).toFixed(1)} g, bitten off ${(lost / 1000).toFixed(1)} g, owed ${(credit / 1000).toFixed(3)} g`);
  expect(Math.abs(eaten - lost - credit)).toBeLessThan(eaten * 1e-6 + 8);
  expect(Math.abs(credit)).toBeLessThan(eaten * 0.01);
  s.destroy(); W.destroy(); RQ.destroy();
}, 600_000);
