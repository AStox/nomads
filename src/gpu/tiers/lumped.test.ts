import { afterAll, expect, test } from "bun:test";
import { type Gpu, openGpu, releaseGpu, theGpu } from "../device";
import { multinom, rinit } from "../rand";
import { Store, loadStore } from "../store";
import { HOUR } from "./drivers";
import { type Bin, DEATH, type Fate, Lumped, PROMOTED, type Split, keyOf } from "./lumped";

let low: Gpu | null = null;
afterAll(async () => { low?.device.destroy(); await releaseGpu(); });

const DAY = 24 * HOUR, P = (x: number) => Math.floor(x * 2 ** 32);
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
