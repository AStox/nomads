import { afterAll, expect, test } from "bun:test";
import { type Gpu, openGpu, releaseGpu, theGpu } from "../device";
import { multinom, philox, rinit } from "../rand";
import { storage } from "../kernel";
import { Store, loadStore } from "../store";
import { DAY } from "../../sim/ticks";
import { type Bin, DEATH, EATEN, FATE, type Fate, Lumped, PROMOTED, REQ_MAX, type Split, TAKEN, keyOf, lstream } from "./lumped";

let low: Gpu | null = null;
afterAll(async () => { low?.device.destroy(); await releaseGpu(); });

const P = (x: number) => Math.floor(x * 2 ** 32);
// Flies: egg 0, larva 1, pupa 2, adult 3. A day's chances: eggs die 2% and hatch 10%; larvae die 3% and pupate 8%;
// pupae stay 84%, die 1% and emerge 15% (the stay listed first); adults die 6%. Each cell's input adds to the first
// boundary and so to the first outcome's chance.
const LAW = `
fn law(cell: u32, state: u32, tick: u32) -> Split {
  var sp: Split;
  let extra = inp[cell % 4u];
  sp.m = 2u;
  if (state == 0u) { sp.t[0] = ${P(0.02)}u + extra; sp.t[1] = ${P(0.12)}u; sp.s[0] = DEATH; sp.s[1] = 1u; sp.s[2] = 0u; }
  else if (state == 1u) { sp.t[0] = ${P(0.03)}u + extra; sp.t[1] = ${P(0.11)}u; sp.s[0] = DEATH; sp.s[1] = 2u; sp.s[2] = 1u; }
  else if (state == 2u) { sp.t[0] = ${P(0.84)}u + extra; sp.t[1] = ${P(0.85)}u + extra; sp.s[0] = 2u; sp.s[1] = DEATH; sp.s[2] = 3u; }
  else { sp.m = 1u; sp.t[0] = ${P(0.06)}u + extra + (tick / ${DAY}u % 3u) * ${P(0.01)}u; sp.s[0] = DEATH; sp.s[1] = 3u; }
  return sp;
}`;
const law = (cell: number, state: number, tick: number, inp: Uint32Array): Split => {
  const x = inp[cell % 4];
  if (state === 0) return { t: [P(0.02) + x, P(0.12)], s: [DEATH, 1, 0] };
  if (state === 1) return { t: [P(0.03) + x, P(0.11)], s: [DEATH, 2, 1] };
  if (state === 2) return { t: [P(0.84) + x, P(0.85) + x], s: [2, DEATH, 3] };
  return { t: [P(0.06) + x + (Math.floor(tick / DAY) % 3) * P(0.01)], s: [DEATH, 3] };
};
const INP = Uint32Array.of(0, P(0.005), P(0.01), 0);
const SIZES = [40, 75, 85, 120, 500, 3000, 4100, 9000, 100_000];

// ---------- the oracle: the same members stepped one by one ----------
// Each bin holds its members as a list of ranks; a step moves members, one at a time, by their ranks under the bin's
// draws, and the counts and new bins come from the members moved.
type Member = { rank: number; token: number };
type OBin = { key: number; e: number; T: number; members: Member[]; dense: boolean };
class Oracle {
  table: OBin[] = [];
  fates = new Map<number, Fate & {}>(); // by token
  next = 0;
  constructor(readonly fly: Lumped) {}
  step(t: number, births: number[], promos: number[], inp: Uint32Array, dense: number, lump: number) {
    const arrivals: { key: number; members: number[] }[] = [];
    for (const b of this.table) {
      for (let r = 0; r < promos.length; r += 3) {
        if (promos[r] !== b.key || promos[r + 1] !== b.e) continue;
        for (const m of b.members.splice(0, Math.min(promos[r + 2], b.members.length))) this.fates.set(m.token, { t, state: PROMOTED });
      }
      if (!b.members.length) continue;
      const state = b.key & 0xffff, sp = law(b.key >>> 16, state, t, inp);
      rinit(this.fly.seed, b.e, b.key, t);
      const c = multinom(b.members.length, sp.t), stay: Member[] = [];
      const leaving = b.members.slice();
      // each member in rank order takes the next place among the departures, outcome by outcome
      let next = 0;
      const out = sp.s.map((s, j) => (s === state ? 0 : c[j]));
      for (let j = 0; j < c.length; j++) {
        if (sp.s[j] === state) continue;
        const went = leaving.slice(next, next + out[j]);
        next += out[j];
        for (const m of went) this.fates.set(m.token, { t, state: sp.s[j] });
        if (sp.s[j] !== DEATH && went.length) arrivals.push({ key: ((b.key & 0xffff0000) | sp.s[j]) >>> 0, members: went.map((m) => m.token) });
      }
      stay.push(...leaving.slice(next));
      b.members = stay;
    }
    for (let i = 0; i < births.length; i += 2) arrivals.push({ key: births[i], members: Array.from({ length: births[i + 1] }, () => this.next++) });
    const kept = this.table.filter((b) => b.members.length).map((b) => {
      const left = b.members.length;
      return { ...b, dense: b.dense ? left >= lump ? false : true : left < dense };
    });
    const keys = [...new Set(arrivals.map((a) => a.key))].sort((a, b) => a - b);
    const made = keys.map((key) => {
      const tokens = arrivals.filter((a) => a.key === key).flatMap((a) => a.members);
      return { key, e: t, T: tokens.length, members: tokens.map((token, rank) => ({ rank, token })), dense: tokens.length < dense };
    });
    this.table = [...kept, ...made];
  }
  bins(): Bin[] {
    return this.table.map((b) => ({ key: b.key, e: b.e, T: b.T, out: b.T - b.members.length, dense: b.dense }));
  }
}

async function flies(g: Gpu, steps: number) {
  const s = new Store(g);
  s.declare({ name: "flyup", capacity: 64, placed: true, fields: ["lkey", "le", "lsig", "stage"].map((name) => ({ name, type: "u32" as const, unit: "", scale: 1 })) });
  const fly = new Lumped(s, { name: "fly", capacity: 2048, members: 65536, seed: 0x5eed, stream: 4, law: LAW, ts: law, active: "flyup", promote: "child_set_stage(slot, state);" });
  fly.inputs(INP);
  const O = new Oracle(fly);
  let births: number[] = [], promos: number[] = [];
  const queue = { add: (cell: number, state: number, n: number) => { fly.add(cell, state, n); births.push(keyOf(cell, state), n); }, promote: (key: number, e: number, n: number) => { fly.promote(key, e, n); promos.push(key, e, n); } };
  s.law({ name: "flies", due: (t) => t % DAY === 0, run: (_, t) => fly.step(t) });
  const tables: Bin[][] = [], dense: string[][] = [];
  const watch: { bin: Bin; rank: number; sigma: number; checks: number }[] = [];
  const tracked: { bin: Bin; rank: number; token: number; fate: Fate; at: number }[] = [];
  let promoted: Bin | null = null, promotedFirst = 0;
  for (let d = 1; d <= steps; d++) {
    if (d === 1) SIZES.forEach((n, c) => queue.add(10 + c, 0, n));
    if (d % 3 === 0) queue.add(5, 0, 160);
    if (d === 2) queue.add(40, 3, 150);
    const t = d * DAY;
    O.step(t, births, promos, INP, fly.dense, fly.lump);
    births = []; promos = [];
    await s.step(t);
    const got = await fly.read();
    expect(got).toEqual(O.bins());
    tables.push(got);
    // members held as individuals: exactly the ranks left of every dense bin, placed by their identities
    const k = s.kind("fly"), K = k.capacity, body = await s.read("fly", "body"), f = (n: string, i: number) => body[(k.field[n] + 1) * K + i];
    const live: string[] = [];
    for (let i = 0; i < K; i++) if (body[i] & 1) {
      const key = f("key", i), e = f("e", i), rank = f("rank", i), b = got[f("bin", i)];
      expect([b.key, b.e, b.T, b.dense]).toEqual([key, e, f("tt", i), true]);
      expect([f("x", i), f("y", i)]).toEqual(Object.values(fly.place(key, e, fly.identity(b, rank))));
      live.push(`${key}:${e}:${rank}`);
    }
    const want = got.filter((b) => b.dense).flatMap((b) => Array.from({ length: b.T - b.out }, (_, j) => `${b.key}:${b.e}:${b.out + j}`));
    expect(live.sort()).toEqual(want.sort());
    dense.push(live);
    // the round trip: on day 6 every bin under 1,000 is held as individuals (and kept so on day 7), on day 8 those of
    // 50 or more are lumped
    if (d === 5) { fly.dense = 1000; fly.lump = 1000; }
    if (d === 7) { fly.dense = 80; fly.lump = 50; }
    if (d === 9) fly.lump = 80;
    // member k of a big bin keeps its identity while others leave and while the world takes some
    if (d === 3) {
      const big = got.find((b) => b.T - b.out > 2000)!;
      watch.push({ bin: big, rank: big.T - 1, sigma: fly.identity(big, big.T - 1), checks: 0 });
      promoted = big; promotedFirst = big.out;
      queue.promote(big.key, big.e, 3);
      // and the member next in line: its fate, asked when it happens and again days later
      const ob = O.table.find((b) => b.key === big.key && b.e === big.e)!, rank = big.out + 3;
      tracked.push({ bin: big, rank, token: ob.members.find((m) => m.rank === rank)!.token, fate: null, at: 0 });
    }
    for (const w of watch) {
      const b = got.find((x) => x.key === w.bin.key && x.e === w.bin.e);
      if (b && w.rank >= b.out) { expect(fly.identity(b, w.rank)).toBe(w.sigma); w.checks++; }
    }
    for (const tr of tracked) {
      const now = fly.fate(tr.bin, tr.rank);
      if (now && !tr.fate) { tr.fate = now; tr.at = d; }
      if (tr.fate) expect(now).toEqual(tr.fate);
    }
  }
  const up = await s.read("flyup", "body");
  return { s, fly, O, tables, dense, watch, tracked, promoted: promoted!, promotedFirst, up };
}

test("a lumped bin stepped and the same members stepped one by one under bin-keyed draws give the same bins every day, on both adapters", async () => {
  const a = await flies(await theGpu(), 24);
  // the counts moved: deaths, hatching, all four stages present, bins of every size, some held as individuals
  const last = a.tables[a.tables.length - 1];
  expect(new Set(last.map((b) => b.key & 0xffff))).toEqual(new Set([0, 1, 2, 3]));
  expect(a.tables.some((t) => t.some((b) => b.T >= 4096))).toBe(true);
  expect(a.dense.some((d) => d.length > 0)).toBe(true);
  low = await openGpu("low-power");
  const b = await flies(low, 24);
  expect(b.tables).toEqual(a.tables);
  expect(b.dense).toEqual(a.dense);
}, 600_000);

test("member k keeps its identity and fate as others leave; promotion keeps identity and state; densify and lump keep counts and identities", async () => {
  const a = await flies(await theGpu(), 14);
  // member k answered with one identity on every day it was still in its bin
  for (const w of a.watch) expect(w.checks).toBeGreaterThan(3);
  // its neighbour's fate, recovered on the day it left and on every day after, is what the oracle saw happen to it
  const tr = a.tracked[0];
  expect(tr.fate).not.toBeNull();
  expect(tr.fate).toEqual(a.O.fates.get(tr.token)!);
  expect(tr.at).toBeLessThan(14);
  // promotion: three full individuals with the identities of the bin's next ranks and their stage
  const fields = a.s.kind("flyup").fields, C = 64, at = (n: string) => (fields.findIndex((f) => f.name === n) + 1) * C;
  const got = [0, 1, 2].map((i) => ({ live: a.up[i] & 1, key: a.up[at("lkey") + i], e: a.up[at("le") + i], sig: a.up[at("lsig") + i], stage: a.up[at("stage") + i], x: a.up[at("x") + i], y: a.up[at("y") + i] }));
  const p = a.promoted;
  expect(got).toEqual([0, 1, 2].map((j) => {
    const sig = a.fly.identity(p, a.promotedFirst + j), at2 = a.fly.place(p.key, p.e, sig);
    return { live: 1, key: p.key, e: p.e, sig, stage: p.key & 0xffff, x: at2.x, y: at2.y };
  }));
  expect(a.fly.fate(p, a.promotedFirst)).toEqual({ t: 4 * DAY, state: PROMOTED });
  // densify and lump: the 150 adults of cell 40 held as individuals on days 6 and 7 and lumped again on day 8, their
  // bin unchanged throughout, its identities the same whether held as individuals or lumped
  const adults = (d: number) => a.tables[d - 1].find((b) => b.key === keyOf(40, 3))!;
  expect([adults(5).dense, adults(6).dense, adults(7).dense, adults(8).dense]).toEqual([false, true, true, false]);
  for (const d of [5, 6, 7, 8]) expect([adults(d).key, adults(d).e, adults(d).T]).toEqual([keyOf(40, 3), 2 * DAY, 150]);
  const held = a.dense[5].filter((s) => s.startsWith(`${keyOf(40, 3)}:`)).length;
  expect(held).toBe(adults(6).T - adults(6).out);
  expect(a.dense[7].filter((s) => s.startsWith(`${keyOf(40, 3)}:`)).length).toBe(0);
}, 600_000);

test("lumped bins, their individuals, queued births and promotions and the fate log saved mid-run and loaded go on the same", async () => {
  const g = await theGpu();
  const world = (s: Store) => {
    s.adopt({ name: "flyup", capacity: 64, placed: true, fields: ["lkey", "le", "lsig", "stage"].map((name) => ({ name, type: "u32" as const, unit: "", scale: 1 })) });
    const fly = new Lumped(s, { name: "fly", capacity: 2048, members: 65536, seed: 0x5eed, stream: 4, law: LAW, ts: law, active: "flyup", promote: "child_set_stage(slot, state);" });
    s.law({ name: "flies", due: (t) => t % DAY === 0, run: (_, t) => fly.step(t) });
    return fly;
  };
  const s = new Store(g), fly = world(s);
  fly.inputs(INP);
  SIZES.forEach((n, c) => fly.add(10 + c, 0, n));
  for (let d = 1; d <= 6; d++) {
    if (d === 3) { const big = (await fly.read()).find((b) => b.T - b.out > 2000)!; fly.promote(big.key, big.e, 2); }
    await s.step(d * DAY);
  }
  // held as individuals: some bins are small by now
  expect((await fly.read()).some((b) => b.dense)).toBe(true);
  // queued for the next step when the store is saved
  const big = (await fly.read()).find((b) => b.T - b.out > 1000)!;
  fly.add(5, 0, 300);
  fly.promote(big.key, big.e, 1);
  const t = loadStore(g, await s.dump()), back = world(t);
  expect(await t.hash()).toBe(await s.hash());
  for (let d = 7; d <= 12; d++) { await s.step(d * DAY); await t.step(d * DAY); }
  expect(await t.hash()).toBe(await s.hash());
  expect(await back.read()).toEqual(await fly.read());
  // fates replay from the saved log: every member of the big bin has the same fate on both
  for (let r = big.out; r < big.out + 50; r++) expect(back.fate(big, r)).toEqual(fly.fate(big, r));
  expect(fly.fate(big, big.out)).toEqual({ t: 7 * DAY, state: PROMOTED });
  s.destroy(); t.destroy();
}, 120_000);

test("the fate log keeps at most its history of steps and none older than the oldest bin, and says so when asked past it", async () => {
  const s = new Store(await theGpu());
  s.declare({ name: "flyup", capacity: 64, placed: true, fields: ["lkey", "le", "lsig", "stage"].map((name) => ({ name, type: "u32" as const, unit: "", scale: 1 })) });
  const fly = new Lumped(s, { name: "fly", capacity: 2048, members: 65536, seed: 0x5eed, stream: 4, law: LAW, ts: law, active: "flyup", promote: "child_set_stage(slot, state);", history: 5 });
  fly.inputs(INP);
  s.law({ name: "flies", due: (t) => t % DAY === 0, run: (_, t) => fly.step(t) });
  fly.add(10, 0, 100_000);
  await s.step(DAY);
  const first = (await fly.read())[0];
  for (let d = 2; d <= 12; d++) await s.step(d * DAY);
  expect(fly.logged).toBe(5);
  const saved = fly.save();
  expect(saved.log.length).toBe(5);
  expect(saved.dropped).toBe(7 * DAY);
  expect(() => fly.fate(first, first.T - 1)).toThrow(/gone from the fate log/);
  // a bin that entered after the oldest step kept is answerable
  const recent = (await fly.read()).find((b) => b.e >= 8 * DAY && b.T > b.out)!;
  expect(fly.fate(recent, recent.T - 1)).toBeNull();
  // with every old bin gone, the steps before the oldest bin left are dropped whatever the history allows
  const t = new Store(await theGpu());
  t.declare({ name: "flyup", capacity: 64, placed: true, fields: ["lkey", "le", "lsig", "stage"].map((name) => ({ name, type: "u32" as const, unit: "", scale: 1 })) });
  const gone = new Lumped(t, { name: "fly", capacity: 2048, members: 65536, seed: 1, stream: 4, active: "flyup", promote: "",
    law: "fn law(cell: u32, state: u32, tick: u32) -> Split { var sp: Split; sp.m = 0u; sp.s[0] = DEATH; _ = &inp; return sp; }", ts: () => ({ t: [], s: [DEATH] }) });
  t.law({ name: "die", due: (x) => x % DAY === 0, run: (_, x) => gone.step(x) });
  for (let d = 1; d <= 10; d++) { gone.add(3, 0, 50); await t.step(d * DAY); }
  // each day's 50 are born and die the next step: the one bin left entered at the last step
  expect(gone.bins).toBe(1);
  expect(gone.logged).toBe(0);
  s.destroy(); t.destroy();
});

// ---------- merging kinds: one bin a key, births on the GPU, takes with fates, the GPU's requests, wide counts ----------
// The flies again, merging: adults also die eaten by predator class 1 (1% a day), and adults that live the day bear 0,
// 3 or 6 eggs (70%, 20%, 10%).
const MLAW = `
fn law(cell: u32, state: u32, tick: u32) -> Split {
  var sp: Split;
  let extra = inp[cell % 4u];
  sp.m = 2u;
  if (state == 0u) { sp.t[0] = ${P(0.02)}u + extra; sp.t[1] = ${P(0.12)}u; sp.s[0] = DEATH; sp.s[1] = 1u; sp.s[2] = 0u; }
  else if (state == 1u) { sp.t[0] = ${P(0.03)}u + extra; sp.t[1] = ${P(0.11)}u; sp.s[0] = DEATH; sp.s[1] = 2u; sp.s[2] = 1u; }
  else if (state == 2u) { sp.t[0] = ${P(0.84)}u + extra; sp.t[1] = ${P(0.85)}u + extra; sp.s[0] = 2u; sp.s[1] = DEATH; sp.s[2] = 3u; }
  else {
    sp.t[0] = ${P(0.06)}u + extra; sp.t[1] = ${P(0.07)}u + extra; sp.s[0] = DEATH; sp.s[1] = ${EATEN(1)}u; sp.s[2] = 3u;
    sp.bm = 2u; sp.bt[0] = ${P(0.7)}u; sp.bt[1] = ${P(0.9)}u; sp.bo = 4u; sp.bs = 0u; sp.bk = 3u;
  }
  return sp;
}`;
const mlaw = (cell: number, state: number, tick: number, inp: Uint32Array): Split => {
  if (state !== 3) return law(cell, state, tick, inp);
  const x = inp[cell % 4];
  return { t: [P(0.06) + x, P(0.07) + x], s: [DEATH, EATEN(1), 3], b: { t: [P(0.7), P(0.9)], k: 3, mask: 4, state: 0 } };
};
const NONE = 0xffffffff;
// The merging oracle: every member a token in rank order, each step's takes, splits, births and merge done member by
// member in the order the tier gives them.
type MBin = { key: number; e: number; part: number; members: number[] };
class MOracle {
  table: MBin[] = [];
  // every token's departures in order: a member that moves on goes on as a member of the bin it reached
  fates = new Map<number, (Fate & {})[]>();
  fate(token: number, after: number) { return (this.fates.get(token) ?? []).find((f) => f.t > after) ?? null; }
  left(token: number, f: Fate & {}) { this.fates.set(token, [...(this.fates.get(token) ?? []), f]); }
  next = 0;
  promoted: { token: number; key: number; e: number; T: number; rank: number; state: number }[] = [];
  constructor(readonly L: Lumped, readonly tw: typeof mlaw) {}
  step(t: number, takes: number[], gkeys: number[], births: number[], gbirths: number[], inp: Uint32Array) {
    const take = (key: number, e: number, count: number, code: number) => {
      const b = this.table.find((x) => x.key === key && (e === NONE || x.e === e) && x.members.length);
      if (!b) return;
      const T = b.members.length;
      b.members.splice(0, Math.min(count, T)).forEach((token, i) => {
        this.left(token, { t, state: code });
        if (code === PROMOTED) this.promoted.push({ token, key: b.key, e: b.e, T, rank: i, state: b.key & 0xffff });
      });
    };
    for (let q = 0; q < takes.length; q += 4) take(takes[q], takes[q + 1], takes[q + 2], takes[q + 3]);
    let g = 0;
    for (const key of gkeys) { if (key === NONE) continue; if (g >= REQ_MAX) break; take(key, NONE, 1, PROMOTED); g++; }
    const moves: { key: number; toks: number[] }[] = [];
    for (const b of this.table) {
      if (!b.members.length) continue;
      const state = b.key & 0xffff, sp = this.tw(b.key >>> 16, state, t, inp);
      rinit(this.L.seed, lstream(b.e, b.part), b.key, t);
      const c = multinom(b.members.length, sp.t), born = Lumped.born(sp, c);
      let at = 0;
      for (let j = 0; j < c.length; j++) {
        if (sp.s[j] === state) continue;
        const went = b.members.slice(at, at + c[j]);
        at += c[j];
        for (const m of went) this.left(m, { t, state: sp.s[j] });
        if (sp.s[j] < FATE && went.length) moves.push({ key: ((b.key & 0xffff0000) | sp.s[j]) >>> 0, toks: went });
      }
      if (born) moves.push({ key: ((b.key & 0xffff0000) | sp.b!.state) >>> 0, toks: Array.from({ length: born }, () => this.next++) });
      b.members = b.members.slice(at);
    }
    const contrib = [
      ...this.table.filter((b) => b.members.length).map((b) => ({ key: b.key, toks: b.members })), ...moves,
      ...[...births, ...gbirths].flatMap((x, i, a) => (i % 2 === 0 && a[i + 1] > 0 ? [{ key: x, toks: Array.from({ length: a[i + 1] }, () => this.next++) }] : [])),
    ];
    const keys = [...new Set(contrib.map((x) => x.key))].sort((a, b) => a - b);
    this.table = keys.map((key) => ({ key, e: t, part: 0, members: contrib.filter((x) => x.key === key).flatMap((x) => x.toks) }));
  }
  bins(): Bin[] { return this.table.map((b) => ({ key: b.key, e: b.e, T: b.members.length, out: 0, dense: false })); }
}

async function merging(g: Gpu, days: number) {
  const s = new Store(g);
  s.declare({ name: "flyup", capacity: 64, placed: true, fields: ["lkey", "le", "lsig", "lstate"].map((name) => ({ name, type: "u32" as const, unit: "", scale: 1 })) });
  const fly = new Lumped(s, { name: "fly", capacity: 4096, members: 1, seed: 0x5eed, stream: 5, law: MLAW, ts: mlaw, active: "flyup", promote: "", merge: true });
  fly.inputs(INP);
  fly.watch([10, 40]);
  s.law({ name: "flies", due: (t) => t % DAY === 0, run: (_, t) => fly.step(t) });
  const O = new MOracle(fly, mlaw), gb = storage(g, 64), gq = storage(g, 4 * 8);
  const tables: Bin[][] = [], tracked: { bin: Bin; rank: number; token: number; fate: Fate; seen: number }[] = [];
  for (let d = 1; d <= days; d++) {
    const t = d * DAY, births: number[] = [], takes: number[] = [];
    if (d === 1) SIZES.forEach((n, c) => { fly.add(10 + c, 0, n); births.push(keyOf(10 + c, 0), n); });
    if (d === 2) { fly.add(40, 3, 5000); births.push(keyOf(40, 3), 5000); }
    // the GPU's births every third day, zeros among them
    const gbirths = d % 3 === 0 ? [keyOf(5, 0), 160, keyOf(6, 1), 0, keyOf(5, 0), 7, keyOf(41, 2), 90] : [];
    if (gbirths.length) { g.device.queue.writeBuffer(gb, 0, Uint32Array.from(gbirths)); fly.bornFrom(gb, gbirths.length / 2); }
    // the GPU's requests on days 4 and 7: adults of cell 40, a key with none, and larvae of cell 18
    const gkeys = d === 4 || d === 7 ? [keyOf(40, 3), NONE, keyOf(99, 3), keyOf(18, 1), NONE, keyOf(40, 3), NONE, NONE] : [];
    if (gkeys.length) { g.device.queue.writeBuffer(gq, 0, Uint32Array.from(gkeys)); fly.requests(gq, gkeys.length); }
    // the CPU's takes on day 5: two promoted from the biggest bin, people take 10 eggs of cell 10
    if (d === 5) {
      const now = await fly.read(), big = now.reduce((a, b) => (b.T > a.T ? b : a)), eggs = now.find((b) => b.key === keyOf(10, 0));
      fly.take(big.key, big.e, 2, PROMOTED); takes.push(big.key, big.e, 2, PROMOTED);
      if (eggs) { fly.take(eggs.key, eggs.e, 10, TAKEN); takes.push(eggs.key, eggs.e, 10, TAKEN); }
    }
    O.step(t, takes, gkeys, births, gbirths, INP);
    await s.step(t);
    const got = await fly.read();
    expect(got).toEqual(O.bins());
    tables.push(got);
    // members of a watched cell followed: their fates replayed through the merged bins as the oracle saw them
    if (d === 3 || d === 6) for (const b of got.filter((x) => x.key >>> 16 === 10 || x.key >>> 16 === 40)) {
      const ob = O.table.find((x) => x.key === b.key)!;
      for (const rank of [0, b.T >> 1, b.T - 1]) tracked.push({ bin: b, rank, token: ob.members[rank], fate: null, seen: 0 });
    }
    for (const tr of tracked) {
      const now = fly.fate(tr.bin, tr.rank), want = O.fate(tr.token, tr.bin.e);
      expect(now).toEqual(want);
      if (now) tr.seen++;
    }
  }
  const up = await s.read("flyup", "body");
  s.destroy(); gb.destroy(); gq.destroy();
  return { fly, O, tables, tracked, up };
}

test("a merging kind: one bin a key, stayers first; births of its law and of the GPU; takes with fates and the GPU's requests; fates replayed in watched cells; the same on both adapters", async () => {
  const a = await merging(await theGpu(), 12);
  // a key's bin entered at the last step, the stayers' link kept by the oracle's tokens
  for (const tb of a.tables) for (const b of tb) expect(new Set(tb.map((x) => x.key)).size).toBe(tb.length);
  // eaten and promoted fates seen, births of the law seen (eggs in cell 40 from adults laid there on day 2)
  const fates = [...a.O.fates.values()].flat().map((f) => f.state);
  expect(fates).toContain(EATEN(1));
  expect(fates).toContain(PROMOTED);
  expect(fates).toContain(TAKEN);
  expect(a.tables.some((tb) => tb.some((b) => b.key === keyOf(40, 0)))).toBe(true);
  expect(a.tracked.some((t) => t.seen > 0)).toBe(true);
  // the promoted: their identity in the bin they left, their state then, and their steps after under the same law
  const C = 64, fields = ["lkey", "le", "lsig", "lstate"], at = (n: string) => (fields.indexOf(n) + 3) * C;
  const up = Array.from({ length: C }, (_, i) => ({ live: a.up[i] & 1, key: a.up[at("lkey") + i], e: a.up[at("le") + i], sig: a.up[at("lsig") + i], state: a.up[at("lstate") + i] }));
  expect(a.O.promoted.length).toBeGreaterThan(2);
  for (const p of a.O.promoted) {
    const sig = a.fly.identity({ key: p.key, e: p.e, T: p.T }, p.rank);
    // the individual's own steps, from the step it was taken at (takes come first in a step, then the individuals')
    let state = p.state, alive = true;
    for (let t = a.O.fate(p.token, p.e)!.t; t <= 12 * DAY && alive; t += DAY) {
      const sp = mlaw(p.key >>> 16, state, t, INP), u = philox([p.key, sig, p.e, t >>> 0], [a.fly.seed, 0x80000001])[0];
      const s = sp.s[sp.t.filter((b) => b <= u).length];
      if (s >>> 0 >= FATE) alive = false; else state = s;
    }
    const mine = up.filter((x) => x.live === 1 && x.key === p.key && x.e === p.e && x.sig === sig);
    expect(mine.map((x) => x.state)).toEqual(alive ? [state] : []);
  }
  low ??= await openGpu("low-power");
  const b = await merging(low, 12);
  expect(b.tables).toEqual(a.tables);
}, 600_000);

test("a wide kind holds a key's members past 2^31 as parts: their sum the count, each part split on its own stream", async () => {
  const s = new Store(await theGpu());
  s.declare({ name: "grainup", capacity: 8, placed: true, fields: ["lkey", "le", "lsig"].map((name) => ({ name, type: "u32" as const, unit: "", scale: 1 })) });
  const HALF = `fn law(cell: u32, state: u32, tick: u32) -> Split { var sp: Split; sp.m = 1u; sp.t[0] = ${P(0.25)}u; sp.s[0] = DEATH; sp.s[1] = state; _ = &inp; return sp; }`;
  const half = (): Split => ({ t: [P(0.25)], s: [DEATH, 1] });
  const sand = new Lumped(s, { name: "sand", capacity: 64, members: 1, seed: 3, stream: 9, law: HALF, ts: half, active: "grainup", promote: "", merge: true, wide: true });
  s.law({ name: "sand", due: (t) => t % DAY === 0, run: (_, t) => sand.step(t) });
  const N0 = 3_000_000_000;
  sand.add(7, 1, N0); sand.add(7, 1, N0); sand.add(8, 1, 1000);
  await s.step(DAY);
  const first = (await sand.read()).filter((b) => b.key === keyOf(7, 1));
  expect(first.reduce((a, b) => a + b.T, 0)).toBe(2 * N0);
  for (const b of first) expect(b.T).toBeLessThanOrEqual(0x7fffffff);
  expect(first.map((b) => b.part)).toEqual(first.map((_, i) => i));
  // the next step: each part keeps three quarters on its own stream, the stayers packed again in part order
  await s.step(2 * DAY);
  const stay = first.map((b) => { rinit(sand.seed, lstream(b.e, b.part!), b.key, 2 * DAY); return multinom(b.T, [P(0.25)])[1]; });
  const packed: number[] = [];
  let acc = 0;
  for (const c of stay) { if (acc > 0 && acc > 0x7fffffff - c) { packed.push(acc); acc = c; } else acc += c; }
  packed.push(acc);
  const second = (await sand.read()).filter((b) => b.key === keyOf(7, 1));
  expect(second.map((b) => b.T)).toEqual(packed);
  expect(second.reduce((a, b) => a + b.T, 0)).toBe(stay.reduce((a, b) => a + b, 0));
  s.destroy();
}, 120_000);
