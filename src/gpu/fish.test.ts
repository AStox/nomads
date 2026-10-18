// The fish's law (wgsl/fish.ts) against its TypeScript oracle, step for step and bit for bit on both adapters, on a
// little water of its own: a lake with a stream running into it, and a strip of sea apart from both. And the island's
// fish over a year on seed 1, their biomass a hectare of each kind of water against the field's (animal-constants sec.
// 13).
import "../sim/world";
import { afterAll, expect, test } from "bun:test";
import { openGpu, releaseGpu, theGpu, type Gpu } from "./device";
import { readback } from "./kernel";
import { Store } from "./store";
import { FISH, Fish, type FishDriver } from "./fish";
import { divw, mul64, qadd, qdiv, qexp, qln, qmul } from "./fixed";
import { binom, next32, rinit, unif } from "./rand";
import { CTL, CTL_WORDS } from "./wgsl/alloc";
import { CELLS, CELL_MM } from "./wgsl/index";
import {
  BODIES, CEN, CEN_WORDS, CT_, CT_RUNS, F, FLAG, FS, G, GK, K, KIND, KW, NFS, NONE, P, PO, STREAM, SUB, SUB_MM, S_, S_WORDS, T, TILE_MM, TW,
} from "./wgsl/fish";
import { N } from "../terrain/grid";
import { fishConsts, fishDriver, watersOf, fishOf } from "../sim/waters";
import { DAY, YEAR_DAYS } from "../sim/ticks";
import { islandOf, newWorld } from "../sim/world";

await islandOf(1);

afterAll(releaseGpu);

// ---------- the oracle: a day of the law, step for step as the WGSL does it ----------
const u = (x: number) => x >>> 0;
const i32 = (x: number) => x | 0;
const mulq = (a: number, q: number) => { const p = mul64(a, q); return p[1] >= 65536 ? NONE : u((p[0] >>> 16) | (p[1] << 16)); };
const muldiv = (a: number, b: number, c: number) => { if (c === 0) return 0; const p = mul64(a, b); return p[1] >= c ? NONE : divw(p[1], p[0], c)[0]; };
const satSub = (a: number, b: number) => (a > b ? u(a - b) : 0);
const bern16 = (p: number) => { const r = next32(); return p >= 65536 || r < u(p << 16); };
type State = { cap: number; b: Uint32Array; CT: Uint32Array; FOOD: Uint32Array; KP: Uint32Array; FT: Uint32Array; EAT: Uint32Array; S: Uint32Array; Q: Uint32Array; alloc: Uint32Array };
function oracleDay(st: State) {
  const { cap, b, CT, FOOD, KP, FT, EAT, S, Q } = st;
  const fo = (f: number) => (f + 1) * cap;
  const kk = (s: number, w: number) => KP[s * KW + w], kg = (w: number) => KP[GK + w], pp = (w: number) => KP[PO + w];
  const ct = (run: number, c: number) => CT[run * CELLS + c];
  const cellOf = (x: number, y: number) => Math.min(Math.floor(y / CELL_MM), N - 1) * N + Math.min(Math.floor(x / CELL_MM), N - 1);
  const tileOf = (x: number, y: number) => Math.min(Math.floor(y / TILE_MM), TW - 1) * TW + Math.min(Math.floor(x / TILE_MM), TW - 1);
  const massq = (s: number, len: number) => { const l = i32(muldiv(len, 65536, 10000)); return l <= 0 ? 0 : u(qexp(qadd(i32(kk(s, K.lna)), qmul(i32(kk(s, K.b)), qln(l))))); };
  const grown = (s: number, k: number, len: number) => { const li = kk(s, K.linf + k - 1); return len >= li ? len : u(li - mulq(li - len, kk(s, K.keep + k - 1))); };
  const dies = (k: number, w: number) => {
    if (w === 0) return 65536;
    const m = qmul(i32(kg(G.mu + k - 1)), qexp(qmul(i32(kg(G.mb + k - 1)), qln(i32(w)))));
    return u(65536 - qexp(-qmul(m, i32(kg(G.pace)))));
  };
  const place = (c: number): [number, number] => {
    const m0 = ct(CT_.m0, c), m1 = ct(CT_.m1, c), n = pop(m0) + pop(m1);
    let sq = (SUB / 2) * SUB + SUB / 2;
    if (n > 0) { let k = unif(n); for (let q = 0; q < 64; q++) if (((q < 32 ? m0 >>> q : m1 >>> (q - 32)) & 1) === 1) { if (k === 0) { sq = q; break; } k--; } }
    const dx = unif(SUB_MM), dy = unif(SUB_MM);
    return [(c % N) * CELL_MM + (sq % SUB) * SUB_MM + dx, Math.floor(c / N) * CELL_MM + Math.floor(sq / SUB) * SUB_MM + dy];
  };
  const know = (i: number) => {
    const x = b[fo(F.x) + i], y = b[fo(F.y) + i], c = cellOf(x, y), kb = ct(CT_.kb, c), kind = kb & 3, body = Math.min(kb >>> 2, BODIES - 1);
    const spw = b[fo(F.sp) + i], s = spw & 15, len = b[fo(F.len) + i], w = massq(s, len), t = tileOf(x, y);
    const pd = kind !== 0 ? dies(kind, w) : 65536, ft = FT[t], ate = EAT[t];
    const eaten = ft > 0 ? (ate >= ft ? 65536 : muldiv(ate, 65536, ft)) : 0;
    return { x, y, c, kb, kind, body, spw, s, len, w, t, pd, eaten };
  };
  const add = (at: number, v: number) => { S[at] = u(S[at] + v); };
  // front
  for (let i = 0; i < cap; i++) {
    if ((b[i] & 1) === 0) continue;
    const { c, kind, body, s, len, w, pd, eaten } = know(i);
    if (kind === 0) continue;
    const wcg = muldiv(w, 100, 65536), dw = satSub(massq(s, grown(s, kind, len)), w);
    if (dw > 0) add(S_.sum + c, u(muldiv(dw, 100, 65536) + 1));
    add(S_.d + body, mulq(wcg, pd));
    add(S_.e + body, mulq(wcg, eaten));
  }
  // fate
  const share = (c: number) => { const f = FOOD[c], a = S[S_.sum + c]; return f === 0 ? 0 : a <= f ? 65536 : muldiv(f, 65536, a); };
  const kill = (i: number) => { b[i] = u(b[i] & ~1); };
  for (let i = 0; i < cap; i++) {
    Q[i] = 0;
    if ((b[i] & 1) === 0) continue;
    const { x, y, c, kb, kind, body, spw, s, len, pd, eaten } = know(i);
    const flags = pp(P.flags);
    rinit(pp(P.seed), STREAM.fate, i, pp(P.tick));
    if (kind === 0) { kill(i); continue; }
    if (bern16(eaten)) { kill(i); continue; }
    const dsum = S[S_.d + body], esum = S[S_.e + body];
    const keep = dsum > 0 ? u(65536 - Math.min(65536, muldiv(esum, 65536, dsum))) : 65536;
    if (bern16(mulq(pd, keep))) { kill(i); continue; }
    if (s === FS.eel && flags & FLAG.recruit && len >= kk(s, K.lmat)) { kill(i); continue; }
    const pot = grown(s, kind, len), nl = u(len + mulq(u(pot - len), share(c)));
    let at = c;
    const smolt = s === FS.trout && kind === KIND.stream && (flags & FLAG.smolt) !== 0 && nl >= kk(s, K.smolt);
    if (FOOD[c] === 0 || smolt) {
      for (let r = 0; r < kg(G.run); r++) {
        const d = ct(CT_.down, at);
        if (d === NONE) break;
        at = d;
        if ((ct(CT_.kb, at) & 3) !== KIND.stream) break;
        if (!smolt && FOOD[at] > 0) break;
      }
      if (FOOD[at] === 0) { kill(i); continue; }
    } else {
      const home = kk(s, K.home);
      for (let m = 0; m < kk(s, K.moves + kind - 1); m++) {
        const d = unif(9);
        if (d === 4) continue;
        const nx = (at % N) + (d % 3) - 1, ny = Math.floor(at / N) + Math.floor(d / 3) - 1;
        if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
        const c2 = ny * N + nx, kb2 = ct(CT_.kb, c2);
        if ((kb2 & 3) !== 0 && kb2 >>> 2 === kb >>> 2 && FOOD[c2] > 0 && ((home >>> (kb2 & 3)) & 1) === 1) at = c2;
      }
    }
    let nx = x, ny = y;
    if (at !== c) { [nx, ny] = place(at); b[fo(F.x) + i] = nx; b[fo(F.y) + i] = ny; }
    b[fo(F.len) + i] = nl;
    if (flags & FLAG.recruit && spw & 16 && nl >= kk(s, K.lmat) && kk(s, K.eggs) > 0) {
      const pc = kk(s, K.nurse) === 1 ? ct(CT_.nurse, at) : at;
      if (pc !== NONE) {
        const sh = share(pc);
        if (sh > 0) {
          const pk = (ct(CT_.kb, pc) & 3) - 1, live = u(qexp(-qdiv(i32(kk(s, K.juv + pk)), i32(sh))));
          const eggs = mul64(massq(s, nl), kk(s, K.eggs))[1];
          Q[i] = binom(eggs, u(Math.min(live, 65535) << 16));
        }
      }
    }
    const ng = massq(s, nl) >>> 16, nk = ct(CT_.kb, at) & 3;
    add(S_.cen + CEN.n + s, 1); add(S_.cen + CEN.g + s, ng); add(S_.cen + CEN.kind + nk - 1, ng); add(S_.ftn + tileOf(nx, ny), ng);
  }
  // the young, as the store's births give them slots: the free list's in order, then the tail
  if (pp(P.flags) & FLAG.recruit) {
    const { alloc } = st, head = alloc[CTL.head], avail = alloc[CTL.nfree] - head, tail = alloc[CTL.tail];
    let j = 0;
    for (let p = 0; p < cap; p++) {
      const c = p < tail && (b[p] & 1) === 1 ? Q[p] : 0;
      for (let k = 0; k < c; k++, j++) {
        let slot: number;
        if (j < avail) slot = alloc[CTL_WORDS + head + j];
        else { const e = j - avail; if (e >= cap - tail) continue; slot = tail + e; }
        let gen = ((b[slot] >>> 1) + 1) & 0x7fffffff;
        if (gen === 0) gen = 1;
        b[slot] = u((gen << 1) | 1);
        for (let f = 1; f <= 5; f++) b[f * cap + slot] = 0;
        const ps = b[fo(F.sp) + p] & 15, now = pp(P.tick);
        rinit(pp(P.seed), STREAM.birth, slot, now);
        const r = next32();
        b[fo(F.sp) + slot] = ps | (r < 0x80000000 ? 16 : 0);
        b[fo(F.born) + slot] = now;
        b[fo(F.len) + slot] = kk(ps, K.lrec);
        let c0 = cellOf(b[fo(F.x) + p], b[fo(F.y) + p]);
        if (kk(ps, K.nurse) === 1) c0 = ct(CT_.nurse, c0);
        if (c0 !== NONE) { const [px, py] = place(c0); b[fo(F.x) + slot] = px; b[fo(F.y) + slot] = py; }
      }
    }
  }
  FT.set(S.subarray(S_.ftn, S_.ftn + T));
  EAT.fill(0);
}
function pop(x: number) { let n = 0; for (let v = x >>> 0; v; v &= v - 1) n++; return n; }

// ---------- a little water ----------
// A lake of cells 100 to 109 each way (body 0), a stream along row 105 from cell 110 to 119 running west into it (body
// 0, the lake's nurse its mouth), and a strip of sea, cells 130 to 139 by 100 to 109 (body 1), its squares the upper
// half of each cell. Food a step, cg: the lake's 4,000 a cell, the stream's 600, the sea's 2,000; on a dry day the
// stream's top two cells hold none.
const at = (x: number, y: number) => y * N + x, LAKE_MOUTH = at(110, 105);
function cells() {
  const CT = new Uint32Array(CT_RUNS * CELLS);
  CT.fill(NONE, CT_.down * CELLS, (CT_.down + 1) * CELLS);
  CT.fill(NONE, CT_.nurse * CELLS, (CT_.nurse + 1) * CELLS);
  const set = (c: number, kind: number, body: number, m0: number, m1: number) => {
    CT[CT_.kb * CELLS + c] = kind | (body << 2); CT[CT_.m0 * CELLS + c] = m0 >>> 0; CT[CT_.m1 * CELLS + c] = m1 >>> 0;
  };
  for (let y = 100; y < 110; y++) for (let x = 100; x < 110; x++) { set(at(x, y), KIND.lake, 0, 0xffffffff, 0xffffffff); CT[CT_.nurse * CELLS + at(x, y)] = LAKE_MOUTH; }
  for (let x = 110; x < 120; x++) { const c = at(x, 105); set(c, KIND.stream, 0, 0x00ff0000, 0); CT[CT_.down * CELLS + c] = at(x - 1, 105); CT[CT_.nurse * CELLS + c] = c; }
  for (let y = 100; y < 110; y++) for (let x = 130; x < 140; x++) set(at(x, y), KIND.sea, 1, 0xffffffff, 0);
  return CT;
}
function food(dry: boolean) {
  const f = new Uint32Array(CELLS);
  for (let y = 100; y < 110; y++) for (let x = 100; x < 110; x++) f[at(x, y)] = 4000;
  for (let x = 110; x < 120; x++) f[at(x, 105)] = dry && x >= 118 ? 0 : 600;
  for (let y = 100; y < 110; y++) for (let x = 130; x < 140; x++) f[at(x, y)] = 2000;
  return f;
}
// Fish laid as [kind, female, cell x, cell y, length cm]: trout in the stream (two above the dry reach, two of a
// smolt's length), perch, roach, pike and eels in the lake (silver eels among them), and trout, perch and roach at
// sea.
function laid() {
  const list: [number, number, number, number, number][] = [];
  for (let k = 0; k < 12; k++) list.push([FS.trout, k & 1, 110 + (k % 10), 105, 6 + k * 1.5]);
  for (let k = 0; k < 40; k++) {
    list.push([FS.perch, k & 1, 100 + (k % 10), 100 + Math.floor(k / 4), 8 + (k % 7) * 3]);
    list.push([FS.roach, (k + 1) & 1, 101 + (k % 8), 102 + (k % 6), 7 + (k % 9) * 2.5]);
    list.push([FS.eel, k & 1, 100 + (k % 10), 109 - (k % 10), 20 + (k % 5) * 4]);
    list.push([FS.roach, k & 1, 130 + (k % 10), 100 + (k % 10), 6 + (k % 5) * 3]);
    list.push([FS.perch, k & 1, 131 + (k % 8), 101 + (k % 8), 10 + (k % 6) * 3]);
  }
  for (let k = 0; k < 8; k++) list.push([FS.pike, k & 1, 102 + k, 104, 30 + k * 8], [FS.eel, 1, 103 + k, 106, 40 + k * 3], [FS.trout, k & 1, 133 + k, 103, 25 + k * 6]);
  const cols: Record<string, number[]> = { x: [], y: [], sp: [], born: [], len: [] };
  list.forEach(([s, f, cx, cy, cm], j) => {
    cols.x.push(cx * CELL_MM + 1000 + (j * 7919) % 70000); cols.y.push(cy * CELL_MM + (cy === 105 && cx >= 110 ? 20000 : 1000 + (j * 104729) % 30000));
    cols.sp.push(s | (f << 4)); cols.born.push(0); cols.len.push(Math.round(cm * 1e4));
  });
  return { n: list.length, cols: Object.fromEntries(Object.entries(cols).map(([k, v]) => [k, Uint32Array.from(v)])) };
}
// The days run: an ordinary one, a dry one, a smolts' one and the recruits' day, at ticks a day apart.
const DAYS: { t: number; flags: number; dry: boolean }[] = [
  { t: DAY * 10, flags: 0, dry: false }, { t: DAY * 11, flags: 0, dry: true }, { t: DAY * 12, flags: FLAG.smolt, dry: false }, { t: DAY * 13, flags: FLAG.recruit, dry: false },
];
const driver = (): FishDriver => ({
  seed: 11, days: 0, t0: 0, cells, consts: fishConsts, start: () => new Uint32Array(0),
  step: (t) => { const d = DAYS.find((x) => x.t === t)!; return { flags: d.flags, food: food(d.dry) }; },
});
// The birds' catch laid before the first day: the lake's first tile held 30 kg and lost 3 of it; the sea's first lost
// all it held.
const FT0 = new Uint32Array(T), EAT0 = new Uint32Array(T);
FT0[50 * TW + 50] = 30000; EAT0[50 * TW + 50] = 3000; FT0[50 * TW + 65] = 5000; EAT0[50 * TW + 65] = 9000;

async function run(g: Gpu) {
  const s = new Store(g), host = new Fish();
  await host.attach(s, driver());
  const { n, cols } = laid();
  s.write(FISH, n, cols);
  s.index(s.kind(FISH));
  s.flush();
  const k = s.kind(FISH), bufs = host.buffersForTest!;
  g.device.queue.writeBuffer(bufs.FT, 0, FT0); g.device.queue.writeBuffer(bufs.EAT, 0, EAT0);
  const start = { b: await s.read(FISH, "body"), KP: new Uint32Array(await readback(g, bufs.KP)), CT: new Uint32Array(await readback(g, bufs.CT)) };
  const out: { b: Uint32Array; FT: Uint32Array; cen: Uint32Array; alloc: Uint32Array }[] = [];
  for (const d of DAYS) {
    const alloc = await s.read(FISH, "alloc");
    await s.step(d.t);
    const S = new Uint32Array(await readback(g, bufs.S));
    out.push({ b: await s.read(FISH, "body"), FT: new Uint32Array(await readback(g, bufs.FT)), cen: S.slice(S_.cen, S_.cen + CEN_WORDS), alloc });
  }
  host.destroy(); s.destroy();
  return { start, out, cap: k.capacity };
}

test("four days of the fish: the catch, deaths, growth, a reach running dry, the smolts' run and the young, bit for bit with the oracle on both adapters; no fish leaves its own water", async () => {
  const hi = await run(await theGpu());
  const low = await openGpu("low-power"), lo = await run(low);
  low.device.destroy();
  const cap = hi.cap, st: State = {
    cap, b: hi.start.b.slice(), CT: hi.start.CT, FOOD: new Uint32Array(CELLS), KP: hi.start.KP.slice(), FT: FT0.slice(), EAT: EAT0.slice(),
    S: new Uint32Array(S_WORDS), Q: new Uint32Array(cap), alloc: new Uint32Array(0),
  };
  const bodyOf = (b: Uint32Array, i: number) => hi.start.CT[CT_.kb * CELLS + Math.min(Math.floor(b[(F.y + 1) * cap + i] / CELL_MM), N - 1) * N + Math.min(Math.floor(b[(F.x + 1) * cap + i] / CELL_MM), N - 1)] >>> 2;
  const n0 = laid().n, home = Array.from({ length: n0 }, (_, i) => bodyOf(hi.start.b, i));
  DAYS.forEach((d, k) => {
    st.FOOD = food(d.dry); st.S.fill(0); st.alloc = hi.out[k].alloc;
    st.KP.set([d.t >>> 0, 11, d.flags], PO);
    oracleDay(st);
    expect(hi.out[k].b).toEqual(st.b);
    expect(hi.out[k].FT).toEqual(st.FT);
    expect(hi.out[k].cen).toEqual(st.S.slice(S_.cen, S_.cen + CEN_WORDS));
    expect(lo.out[k].b).toEqual(hi.out[k].b);
    expect(lo.out[k].FT).toEqual(hi.out[k].FT);
  });
  const b = hi.out[DAYS.length - 1].b, alive = (i: number) => (b[i] & 1) === 1, same = (i: number) => alive(i) && b[i] >>> 1 === hi.start.b[i] >>> 1;
  // every first fish still alive (its slot not given to a young one since) is in the body of water it started in
  for (let i = 0; i < n0; i++) if (same(i)) expect(bodyOf(b, i)).toBe(home[i]);
  // the law did what each day asks: fish died, the dry reach's fish went down or died, smolts reached the lake, and
  // young were born
  const born = Array.from({ length: cap }, (_, i) => i).filter((i) => alive(i) && (i >= n0 || !same(i)));
  expect(Array.from({ length: n0 }, (_, i) => i).filter((i) => !same(i)).length).toBeGreaterThan(0);
  expect(born.length).toBeGreaterThan(0);
  // after the smolts' day every trout of a smolt's length that began in the stream has left it (they may wander back
  // from the lake later, as their home allows)
  const sb = hi.out[2].b, smoltSame = (i: number) => (sb[i] & 1) === 1 && sb[i] >>> 1 === hi.start.b[i] >>> 1;
  const inStream = (b: Uint32Array, i: number) => Math.floor(b[(F.y + 1) * cap + i] / CELL_MM) === 105 && Math.floor(b[(F.x + 1) * cap + i] / CELL_MM) >= 110;
  // only those in the stream as the smolts' day began (the day before's end): a lake trout wandering in that day is not
  // one that stayed
  for (let i = 0; i < n0; i++) if (smoltSame(i) && inStream(hi.out[1].b, i) && (sb[(F.sp + 1) * cap + i] & 15) === FS.trout && sb[(F.len + 1) * cap + i] >= 120000 && home[i] === 0) expect(inStream(sb, i)).toBe(false);
}, 600_000);

// ---------- the island's fish over a year ----------
// Field values (sec. 13): the herds' stocks' 46 to 51 kg a ha of inshore water (sec. 9, the model before this one);
// trout in Danish brooks, whose production 6.9 to 15.9 g a m2 a year (R851) is about their biomass; the world's stream
// salmonids, 5.2 g a m2 on average, most under 10 (R852).
test("seed 1's fish over an island year: biomass a hectare of sea, lake and stream, recorded against the field", async () => {
  const w = newWorld(1, 0), v = watersOf(1), s = new Store(await theGpu()), host = fishOf(w);
  const ha = [0, 0, 0];
  for (let c = 0; c < CELLS; c++) if (v.kind[c]) ha[v.kind[c] - 1] += v.area[c] / 1e4;
  await host.attach(s, fishDriver(w));
  const kgHa = () => [0, 1, 2].map((k) => host.census[CEN.kind + k] / 1000 / ha[k]);
  const rows: string[] = [];
  let t = Math.ceil(w.t / DAY) * DAY;
  for (let d = 0; d <= YEAR_DAYS; d++, t += DAY) {
    await s.step(t);
    const c = host.census, n = Array.from(c.subarray(CEN.n, CEN.n + NFS));
    if (d % 5 === 0) rows.push(`day ${d}: ${n.reduce((a, b) => a + b, 0)} fish ${JSON.stringify(n)}, kg/ha sea ${kgHa()[0].toFixed(1)}, lake ${kgHa()[1].toFixed(1)}, stream ${kgHa()[2].toFixed(1)}`);
  }
  console.log(`seed 1 water: sea ${ha[0].toFixed(0)} ha, lakes ${ha[1].toFixed(0)} ha, streams ${ha[2].toFixed(1)} ha, ${v.bodies} bodies\n${rows.join("\n")}`);
  const last = kgHa();
  // every kind of water holds fish at the year's end (how many against the field is recorded in sec. 13, not asserted)
  for (const x of last) expect(x).toBeGreaterThan(0);
  host.destroy(); s.destroy();
}, 1_800_000);
