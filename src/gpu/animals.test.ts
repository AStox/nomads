// The animals' law (wgsl/animals.ts, driven by animals.ts): a TypeScript oracle of every kernel of a step, the old
// herds' rules now each animal's own, and the plan's checks (Unit 10): a lone deer's energy over a day equals the
// oracle's bit for bit, and two wolves claiming one deer resolve the same way every run, on the high-performance and
// the low-power adapter alike.
import "../sim/world";
import { lawConsts } from "../sim/animals";
import { afterAll, expect, test } from "bun:test";
import { openGpu, releaseGpu, theGpu, type Gpu } from "./device";
import { readback } from "./kernel";
import { Store } from "./store";
import { ANIMAL, Animals, type AnimalDriver } from "./animals";
import { N } from "../terrain/grid";
import { divw, mul64, qexp, qmul } from "./fixed";
import { next32, rinit, unif } from "./rand";
import {
  A_, CLS, DR, DRIVERS, DT, DTAB, F, FLAG, G, GK, K, KW, L, NL, NONE, NPOOL, NSP, PACK, PO, PO_, P, Q_, Q_RUNS, SATW, SP, STATIC_RUNS, STREAM, T, TILE_MM, TW, W_, W_RUNS, WTAB, WTN, aWords, larAt,
} from "./wgsl/animals";

afterAll(releaseGpu);

// ---------- the oracle ----------
const u = (x: number) => x >>> 0;
const tileOf = (x: number, y: number) => Math.min(Math.floor(y / TILE_MM), TW - 1) * TW + Math.min(Math.floor(x / TILE_MM), TW - 1);
const satAdd = (a: number, b: number) => { const s = u(a + b); return s < a ? NONE : s; };
const satSub = (a: number, b: number) => (a > b ? a - b : 0);
const smul = (a: number, b: number) => { const p = mul64(a, b); return p[1] !== 0 ? NONE : p[0]; };
const mulq = (a: number, q: number) => { const p = mul64(a, q); return p[1] >= 65536 ? NONE : u((p[0] >>> 16) | (p[1] << 16)); };
const muldiv = (a: number, b: number, c: number) => { if (c === 0) return 0; const p = mul64(a, b); return p[1] >= c ? NONE : divw(p[1], p[0], c)[0]; };
const resp = (s: number, d: number) => { const den = satAdd(s, d); return den === 0 ? 0 : muldiv(s, 65536, den); };
const q32of = (a: number, b: number) => (b === 0 || a >= b ? NONE : divw(a, 0, b)[0]);
const bern16 = (p: number) => { const r = next32(); return p >= 65536 || r < u(p << 16); };
const i32 = (x: number) => x | 0;

// A step's state, as the buffers hold it.
type State = { cap: number; b: Uint32Array; W: Uint32Array; A: Uint32Array; KP: Uint32Array; D: Uint32Array };
function oracleStep(st: State) {
  const { cap, b, W, A, KP, D } = st, fo = (f: number) => (f + 1) * cap;
  const kk = (s: number, w: number) => KP[s * KW + w], kg = (w: number) => KP[GK + w], pp = (w: number) => KP[PO + w];
  const fe = (i: number) => i32(b[fo(F.e) + i]);
  if (pp(P.flags) & (FLAG.calve | FLAG.kits | FLAG.whelp | FLAG.cub | FLAG.heron | FLAG.eagle | FLAG.gull | FLAG.crow)) throw new Error("the oracle steps no births");
  const S = new Uint32Array(NL * SATW), Q = new Uint32Array(Q_RUNS * cap), TERR = new Uint32Array(3 * cap);
  A.fill(0, 0, A_.carr); A.fill(0, A_.cen, larAt(cap));
  // the index, as the store builds it: live slots by cell, each cell's in slot order
  const cellOf = (s: number) => Math.min(Math.floor(b[fo(F.y) + s] / 75000), N - 1) * N + Math.min(Math.floor(b[fo(F.x) + s] / 75000), N - 1);
  const runs = new Map<number, number[]>();
  for (let s = 0; s < cap; s++) if (b[s] & 1) { const c = cellOf(s); let l = runs.get(c); if (!l) runs.set(c, (l = [])); l.push(s); }
  const takeable = (s: number, sp: number) => (b[s] & 1) === 1 && b[fo(F.held) + s] === 0 && (b[fo(F.sp) + s] & 15) === sp;
  const tcell = (t: number, q: number) => (2 * Math.floor(t / TW) + (q >> 1)) * N + 2 * (t % TW) + (q & 1);
  const kth = (t: number, sp: number, k: number) => {
    let n = 0;
    for (let q = 0; q < 4; q++) for (const s of runs.get(tcell(t, q)) ?? []) if (takeable(s, sp)) { if (n === k) return s; n++; }
    return NONE;
  };
  const w = (run: number, t: number) => W[run * T + t];
  const set = (run: number, t: number, v: number) => { W[run * T + t] = u(v); };
  const d0 = pp(P.day) * DRIVERS * T, per = pp(P.per);
  const iced = (j: number) => w(W_.lake, j) === 1 && i32(D[d0 + DR.temp * T + j]) < 0;
  // grow
  for (let t = 0; t < T; t++) {
    const temp = i32(D[d0 + DR.temp * T + t]);
    for (let l = 0; l < NL; l++) set(W_.layer + l, t, 0);
    const laid = A[A_.carr + t]; A[A_.carr + t] = 0;
    if (w(W_.land, t) === 0) { if (!iced(t)) set(W_.layer + L.fish, t, Math.floor(w(W_.fish, t) / 10)); continue; }
    set(W_.layer + L.land, t, 1);
    const grown = Math.floor(D[d0 + DR.grow * T + t] / per);
    const dies = u(65536 - qexp(-i32(Math.floor(D[d0 + DR.leafk * T + t] / per)))), keep = u(65536 - dies);
    const rots = kg(G.rots), most = kg(G.most), fg = w(W_.fg, t), fd = w(W_.fd, t);
    const room = 65536 - i32(Math.floor(u(fg + fd) / most));
    const fpos = Math.max(0, i32(fg) + qmul(qmul(i32(grown), i32(w(W_.lit, t))), room));
    const fg2 = mulq(fpos, keep), fd2 = mulq(u(fd + mulq(fpos, dies)), rots);
    set(W_.fg, t, fg2); set(W_.fd, t, fd2);
    const bg = w(W_.bg, t), bd = w(W_.bd, t), broom = 65536 - i32(Math.floor(u(bg + bd) / most));
    const bpos = Math.max(0, i32(bg) + qmul(i32(grown), broom)), bare = D[d0 + DR.bare * T + t];
    let fall = dies;
    const was = w(W_.wasbare, t);
    if (bare === 1 && was === 0) { fall = u(65536 - mulq(keep, w(W_.ever, t))); set(W_.tw, t, kg(G.twig)); }
    if (bare === 0 && was === 1) set(W_.tw, t, 0);
    set(W_.wasbare, t, bare);
    const bg2 = mulq(bpos, u(65536 - fall)), bd2 = mulq(u(bd + mulq(bpos, fall)), rots);
    set(W_.bg, t, bg2); set(W_.bd, t, bd2);
    const gone = Math.floor(mulq(Math.max(0, temp), kg(G.daysq)) / kg(G.rotdd));
    const carr = mulq(satAdd(w(W_.carr, t), laid), satSub(65536, gone));
    set(W_.carr, t, carr);
    let stripg = 0, m2 = 0, any = false;
    for (let m = 0; m < 4; m++) {
      const j = w(W_.sw + m, t);
      if (j === NONE) continue;
      any = true;
      if (iced(j)) continue;
      const sa = w(W_.sa + m, t);
      stripg = u(stripg + mulq(w(W_.fish, j), sa)); m2 = u(m2 + mulq(kg(G.m2), sa));
    }
    let shore = w(W_.shore, t);
    if (any) { shore = u(shore + mulq(satSub(kg(G.shmost), shore), kg(G.shrate))); set(W_.shore, t, shore); }
    const shoreg = muldiv(mulq(shore, m2), kg(G.shorej), kg(G.flesh));
    set(W_.stripg, t, stripg); set(W_.stripm2, t, m2); set(W_.shoreg, t, shoreg); set(W_.hresp, t, resp(stripg, mulq(m2, kg(G.hhalf))));
    const open = D[d0 + DR.open * T + t];
    set(W_.open, t, open);
    const ga = mulq(w(W_.grass, t), open), woody = w(W_.woody, t), da = u(ga + woody);
    const gg = mulq(fg2, ga), gd = mulq(fd2, ga), wg = mulq(bg2, woody), wd = mulq(bd2, woody);
    const dtw = da > 0 ? muldiv(mulq(w(W_.tw, t), w(W_.twoody, t)), 65536, da) : 0;
    set(W_.dtw, t, dtw);
    let dgreen = 0, ddead = 0, bq = w(W_.summer, t);
    if (bare === 1) bq = w(W_.winter, t);
    if (da > 0) { dgreen = muldiv(u(gg + wg), 65536, da); ddead = muldiv(u(gd + wd), 65536, da); }
    let gshg = 65536, gshd = 65536;
    if (u(gg + wg) > 0) gshg = muldiv(gg, 65536, u(gg + wg));
    if (u(gd + wd) > 0) gshd = muldiv(gd, 65536, u(gd + wd));
    set(W_.dgreen, t, dgreen); set(W_.ddead, t, ddead); set(W_.gshg, t, gshg); set(W_.gshd, t, gshd); set(W_.bq, t, bq);
    const me = kg(G.me), med = kg(G.med);
    let pd = 0, pr = 0;
    if (da > 0) {
      let q = me;
      if (u(gg + wg) > 0) q = u(muldiv(gg, me, u(gg + wg)) + muldiv(wg, bq, u(gg + wg)));
      const half = kk(SP.deer, K.half), gr = resp(dgreen, half), rt = resp(dtw, half);
      const rest = u(mulq(rt, kg(G.twme)) + mulq(mulq(u(65536 - rt), resp(ddead, half)), med));
      pd = u(mulq(gr, q) + mulq(u(65536 - gr), rest));
    }
    if (ga > 0) {
      const half = kk(SP.rabbit, K.half), gr = resp(fg2, half);
      pr = mulq(w(W_.warren, t), u(mulq(gr, me) + mulq(mulq(u(65536 - gr), resp(fd2, half)), med)));
    }
    set(W_.pdeer, t, pd); set(W_.prabbit, t, pr);
    set(W_.layer + L.carr, t, Math.floor(carr / 10)); set(W_.layer + L.strip, t, Math.floor(stripg / 10)); set(W_.layer + L.shore, t, Math.floor(shoreg / 10));
    if (temp > 0) set(W_.layer + L.worms, t, Math.floor(smul(kg(G.worms), mulq(kg(G.m2), ga)) / 10));
  }
  // cells
  for (let t = 0; t < T; t++) {
    let nd = 0, nr = 0;
    for (let q = 0; q < 4; q++) for (const s of runs.get(tcell(t, q)) ?? []) { if (takeable(s, SP.deer)) nd++; if (takeable(s, SP.rabbit)) nr++; }
    set(W_.layer + L.deer, t, nd); set(W_.layer + L.rabbit, t, nr);
  }
  // the summed-area tables
  for (let l = 0; l < NL; l++) for (let y = 0; y < TW; y++) { let run = 0; for (let x = 0; x < TW; x++) { run = u(run + w(W_.layer + l, y * TW + x)); S[l * SATW + (y + 1) * (TW + 1) + x + 1] = run; } }
  for (let l = 0; l < NL; l++) for (let x = 0; x <= TW; x++) { let acc = 0; for (let y = 1; y <= TW; y++) { acc = u(acc + S[l * SATW + y * (TW + 1) + x]); S[l * SATW + y * (TW + 1) + x] = acc; } }
  const sat = (l: number, Y: number, X: number) => S[l * SATW + Y * (TW + 1) + X];
  const box = (l: number, x0: number, y0: number, x1: number, y1: number) => u(sat(l, y1 + 1, x1 + 1) - sat(l, y0, x1 + 1) - sat(l, y1 + 1, x0) + sat(l, y0, x0));
  const bw = (la: number, wa: number, lb: number, wb: number, x0: number, y0: number, x1: number, y1: number) => u(Math.imul(wa, box(la, x0, y0, x1, y1)) + Math.imul(wb, box(lb, x0, y0, x1, y1)));
  const pick = (la: number, wa: number, lb: number, wb: number, x0: number, y0: number, x1: number, y1: number, v: number): [number, number] => {
    let lo = y0, hi = y1;
    while (lo < hi) { const mid = Math.floor((lo + hi) / 2); if (bw(la, wa, lb, wb, x0, y0, x1, mid) > v) hi = mid; else lo = mid + 1; }
    const r = lo, v2 = r > y0 ? u(v - bw(la, wa, lb, wb, x0, y0, x1, r - 1)) : v;
    lo = x0; hi = x1;
    while (lo < hi) { const mid = Math.floor((lo + hi) / 2); if (bw(la, wa, lb, wb, x0, r, mid, r) > v2) hi = mid; else lo = mid + 1; }
    const c = lo, v3 = c > x0 ? u(v2 - bw(la, wa, lb, wb, x0, r, c - 1, r)) : v2;
    return [r * TW + c, v3];
  };
  const boxof = (t: number, r: number): [number, number, number, number] => { const x = t % TW, y = Math.floor(t / TW); return [x > r ? x - r : 0, y > r ? y - r : 0, Math.min(x + r, TW - 1), Math.min(y + r, TW - 1)]; };
  const anyland = (bx: number[]) => { const n = box(L.land, bx[0], bx[1], bx[2], bx[3]); return n === 0 ? NONE : pick(L.land, 1, L.land, 0, bx[0], bx[1], bx[2], bx[3], unif(n))[0]; };
  // census
  for (let i = 0; i < cap; i++) if (b[i] & 1) A[A_.cen + (b[fo(F.sp) + i] & 15)]++;
  const packAt = (run: number, g: number) => A_.claim + cap * (1 + run) + g;
  // act
  const askAdd = (pool: number, t: number, v: number) => { A[A_.ask + pool * T + t] = u(A[A_.ask + pool * T + t] + v); };
  for (let i = 0; i < cap; i++) {
    const q = (run: number, v: number) => { Q[run * cap + i] = u(v); };
    q(Q_.tgt, NONE); q(Q_.pick, NONE); q(Q_.key, 0);
    if (!(b[i] & 1)) continue;
    const sw = b[fo(F.sp) + i], s = sw & 15, female = (sw >> 4) & 1, held = b[fo(F.held) + i], full = kk(s, K.full), day = pp(P.day);
    const fmr = s === SP.deer ? mulq(kk(s, K.fmr), KP[DTAB + day]) : kk(s, K.fmr);
    const fed = b[fo(F.fed) + i], more = Math.min(u(fed - b[fo(F.fseen) + i]), full);
    b[fo(F.fseen) + i] = fed;
    const e = i32(fe(i) + i32(more) - i32(fmr));
    b[fo(F.e) + i] = u(e);
    const tick = pp(P.tick), flags = pp(P.flags), age = u(tick - b[fo(F.born) + i]), mature = age >= kk(s, K.mature) && age < 0x80000000;
    if (female === 1 && mature) {
      if (s === SP.heron && flags & FLAG.heron) TERR[i] = 1;
      if (s === SP.eagle && flags & FLAG.eagle) TERR[cap + i] = 1;
      if (s === SP.crow && flags & FLAG.crow) TERR[2 * cap + i] = 1;
    }
    const grp = b[fo(F.grp) + i];
    if (s === SP.wolf && grp > 0 && female === 1 && mature && held !== 2 && flags & FLAG.whelp) A[packAt(PACK.breed, grp - 1)] = Math.max(A[packAt(PACK.breed, grp - 1)], u(~i));
    if (s === SP.wolf && grp > 0) {
      A[packAt(PACK.n, grp - 1)]++;
      if (mature) A[packAt(female === 1 ? PACK.fem : PACK.male, grp - 1)]++;
    }
    if (held === 2) continue;
    const want = u(Math.max(0, i32(full) - e)), hungry = e + i32(fmr) < i32(full);
    rinit(pp(P.seed), STREAM.act, i, tick);
    const me = kg(G.me), med = kg(G.med), flesh = kg(G.flesh);
    const home = tileOf(b[fo(F.hx) + i], b[fo(F.hy) + i]), here = tileOf(b[fo(F.x) + i], b[fo(F.y) + i]);
    const claim = (prey: number) => {
      if (prey === NONE) return;
      const key = u((next32() & 0xfff00000) | i);
      A[A_.claim + prey] = Math.max(A[A_.claim + prey], u(~key));
      q(Q_.tgt, prey); q(Q_.key, key);
    };
    if (s === SP.deer) {
      const t = here;
      if (w(W_.land, t) === 0) continue;
      const half = kk(s, K.half), vfi = KP[DTAB + DT + day], g1 = mulq(Math.min(mulq(kk(s, K.capg), vfi), muldiv(want, 1000, me)), resp(w(W_.dgreen, t), half));
      const fill = kk(s, K.capf), used = Math.floor(u(g1 * 4) / 10), twme = kg(G.twme), twndf = kg(G.twndf);
      const troom = fill > used ? Math.floor(((fill - used) * 1000) / twndf) : 0, got = muldiv(g1, me, 1000);
      const t1 = mulq(Math.min(troom, muldiv(satSub(want, got), 1000, twme)), resp(w(W_.dtw, t), half));
      const used2 = used + Math.floor((t1 * twndf) / 1000), room = fill > used2 ? Math.floor(((fill - used2) * 10) / 7) : 0;
      const got2 = u(got + muldiv(t1, twme, 1000));
      const d1 = mulq(Math.min(room, muldiv(satSub(want, got2), 1000, med)), resp(w(W_.ddead, t), half));
      const ag = mulq(g1, w(W_.gshg, t)), ad = mulq(d1, w(W_.gshd, t));
      askAdd(PO_.dg, t, ag); askAdd(PO_.dd, t, ad); askAdd(PO_.dbg, t, g1 - ag); askAdd(PO_.dbd, t, d1 - ad); askAdd(PO_.dtw, t, t1);
      q(Q_.a0, ag); q(Q_.a0 + 1, ad); q(Q_.a0 + 2, g1 - ag); q(Q_.a0 + 3, d1 - ad); q(Q_.a0 + 4, t1); q(Q_.pick, t);
      continue;
    }
    if (s === SP.rabbit) {
      const t = home;
      if (w(W_.land, t) === 0 || w(W_.grass, t) === 0) continue;
      const most = kk(s, K.capf), g1 = mulq(Math.min(most, muldiv(want, 1000, me)), resp(w(W_.fg, t), kk(s, K.half)));
      const got = muldiv(g1, me, 1000), d1 = mulq(Math.min(most - g1, muldiv(satSub(want, got), 1000, med)), resp(w(W_.fd, t), kk(s, K.half)));
      askAdd(PO_.rg, t, g1); askAdd(PO_.rd, t, d1);
      q(Q_.a0, g1); q(Q_.a0 + 1, d1); q(Q_.pick, t);
      continue;
    }
    const bx = boxof(home, kk(s, K.reach)), [x0, y0, x1, y1] = bx;
    if (s === SP.wolf) {
      if (grp > 0) A[packAt(PACK.want, grp - 1)] = u(A[packAt(PACK.want, grp - 1)] + want);
      if (held !== 0) continue;
      const lard = grp > 0 ? A[larAt(cap) + grp - 1] : 0;
      const wd = kk(SP.deer, K.prey), wr = kk(SP.rabbit, K.prey), tot = bw(L.deer, wd, L.rabbit, wr, x0, y0, x1, y1);
      if (hungry && tot > 0 && lard < want) {
        const land = box(L.land, x0, y0, x1, y1), rate = muldiv(kk(s, K.rate), tot, smul(land, kk(s, K.half)));
        const pk = pick(L.deer, wd, L.rabbit, wr, x0, y0, x1, y1, unif(tot));
        q(Q_.pick, pk[0]);
        const nd = u(Math.imul(wd, w(W_.layer + L.deer, pk[0])));
        let prey: number = SP.deer, k = Math.floor(pk[1] / wd);
        if (pk[1] >= nd) { prey = SP.rabbit; k = Math.floor((pk[1] - nd) / wr); }
        let p = q32of(rate, kk(prey, K.kg));
        if (prey === SP.rabbit) p = Math.min(p, kk(s, K.chase));
        if (next32() < p) claim(kth(pk[0], prey, k));
      } else if (lard > 0) q(Q_.pick, here);
      else q(Q_.pick, anyland(bx));
      continue;
    }
    if (s === SP.fox) {
      if (held !== 0) continue;
      const land = box(L.land, x0, y0, x1, y1), nr = box(L.rabbit, x0, y0, x1, y1);
      if (hungry && nr > 0) {
        const a = smul(nr, 100), bb = smul(land, kk(s, K.half));
        let rs: number;
        if (a >= bb) { const x = muldiv(bb, 65536, a); rs = muldiv(65536, 65536, u(65536 + mulq(x, x))); }
        else { const x = muldiv(a, 65536, bb), x2 = mulq(x, x); rs = muldiv(x2, 65536, u(x2 + 65536)); }
        const rate = mulq(kk(s, K.rate), rs);
        if (next32() < q32of(rate, kk(SP.rabbit, K.kg))) {
          const pk = pick(L.rabbit, 1, L.rabbit, 0, x0, y0, x1, y1, unif(nr));
          q(Q_.pick, pk[0]); claim(kth(pk[0], SP.rabbit, pk[1]));
          continue;
        }
      }
      const c = box(L.carr, x0, y0, x1, y1);
      if (hungry && c > 0) {
        const a = mulq(muldiv(want, 1000, flesh), resp(c, smul(land, kk(s, K.half2))));
        const t = pick(L.carr, 1, L.carr, 0, x0, y0, x1, y1, unif(c))[0];
        askAdd(PO_.carr, t, a); q(Q_.a0, a); q(Q_.pick, t);
        continue;
      }
      q(Q_.pick, anyland(bx));
      continue;
    }
    const half = smul(u((x1 - x0 + 1) * (y1 - y0 + 1)), kk(s, K.half));
    if (s === SP.eagle) {
      const wr = kk(SP.rabbit, K.prey), tot = bw(L.rabbit, wr, L.fish, 1, x0, y0, x1, y1), a = mulq(muldiv(want, 1000, flesh), resp(tot, half));
      if (tot === 0 || a === 0) continue;
      const pk = pick(L.rabbit, wr, L.fish, 1, x0, y0, x1, y1, unif(tot));
      q(Q_.pick, pk[0]);
      const nr = u(Math.imul(wr, w(W_.layer + L.rabbit, pk[0])));
      if (pk[1] < nr) {
        if (held === 0 && next32() < q32of(a, smul(kk(SP.rabbit, K.kg), 1000))) claim(kth(pk[0], SP.rabbit, Math.floor(pk[1] / wr)));
        continue;
      }
      askAdd(PO_.water, pk[0], a); q(Q_.a0, a);
      continue;
    }
    if (s === SP.heron) {
      const stp = box(L.strip, x0, y0, x1, y1);
      if (stp === 0) continue;
      const t = pick(L.strip, 1, L.strip, 0, x0, y0, x1, y1, unif(stp))[0], a = mulq(muldiv(want, 1000, flesh), w(W_.hresp, t));
      askAdd(PO_.strip, t, a); q(Q_.a0, a); q(Q_.pick, t);
      continue;
    }
    const lb = s === SP.crow ? L.worms : L.shore, tot = bw(L.carr, 1, lb, 1, x0, y0, x1, y1), a = mulq(muldiv(want, 1000, flesh), resp(tot, half));
    if (tot === 0 || a === 0) continue;
    const t = pick(L.carr, 1, lb, 1, x0, y0, x1, y1, unif(tot))[0], lc = w(W_.layer + L.carr, t), lo = w(W_.layer + lb, t), ac = muldiv(a, lc, u(lc + lo));
    askAdd(PO_.carr, t, ac);
    if (s === SP.gull) askAdd(PO_.shore, t, a - ac);
    q(Q_.a0, ac); q(Q_.a0 + 1, a - ac); q(Q_.pick, t);
  }
  // resolve
  for (let i = 0; i < cap; i++) {
    const prey = Q[Q_.tgt * cap + i];
    if (prey === NONE || A[A_.claim + prey] !== u(~Q[Q_.key * cap + i])) continue;
    b[prey] &= ~1;
    const ps = b[fo(F.sp) + prey] & 15, pt = tileOf(b[fo(F.x) + prey], b[fo(F.y) + prey]), flesh = kg(G.flesh);
    let g = kk(ps, K.kg);
    if (ps === SP.deer) { const rav = mulq(g, kg(G.ravens)); A[A_.carr + pt] += rav; g -= rav; }
    const e = u(Math.imul(g, flesh)), s = b[fo(F.sp) + i] & 15, grp1 = b[fo(F.grp) + i];
    if (s === SP.wolf && grp1 > 0) { A[packAt(PACK.pot, grp1 - 1)] = u(A[packAt(PACK.pot, grp1 - 1)] + e); A[packAt(PACK.tile, grp1 - 1)] = Math.max(A[packAt(PACK.tile, grp1 - 1)], pt + 1); continue; }
    const mine = fe(i), want = u(Math.max(0, i32(kk(s, K.full)) - mine)), eat = Math.min(e, want);
    b[fo(F.e) + i] = u(mine + i32(eat));
    A[A_.carr + pt] += Math.floor((e - eat) / flesh);
  }
  // the lowest-slot grown she-wolf, past the step she could leave home in, whose pack has no grown male
  for (let i = 0; i < cap; i++) {
    const sw = b[fo(F.sp) + i], grp = b[fo(F.grp) + i];
    if (!(b[i] & 1) || (sw & 15) !== SP.wolf || !((sw >> 4) & 1) || grp === 0 || b[fo(F.held) + i] === 2) continue;
    const age = u(pp(P.tick) - b[fo(F.born) + i]);
    if (age >= 0x80000000 || age < kk(SP.wolf, K.mature) + pp(P.tps)) continue;
    if (A[packAt(PACK.male, grp - 1)] === 0) A[A_.lone] = Math.max(A[A_.lone], u(~i));
  }
  // share
  const part = (ask: number, avail: number) => (ask <= avail ? 65536 : muldiv(avail, 65536, ask));
  const askOf = (p: number, t: number) => A[A_.ask + p * T + t];
  for (let t = 0; t < T; t++) {
    for (let p = 0; p < NPOOL; p++) set(W_.share + p, t, 65536);
    if (w(W_.land, t) === 0) { set(W_.share + PO_.water, t, part(askOf(PO_.water, t), smul(w(W_.fish, t), 1000))); continue; }
    const reach = mulq(w(W_.garea, t), w(W_.open, t)), rreach = mulq(reach, w(W_.warren, t)), rg = askOf(PO_.rg, t), rd = askOf(PO_.rd, t);
    const arg = muldiv(w(W_.fg, t), rreach, 65536), ard = muldiv(w(W_.fd, t), rreach, 65536);
    set(W_.share + PO_.rg, t, part(rg, arg)); set(W_.share + PO_.rd, t, part(rd, ard));
    set(W_.share + PO_.dg, t, part(askOf(PO_.dg, t), satSub(muldiv(w(W_.fg, t), reach, 65536), Math.min(rg, arg))));
    set(W_.share + PO_.dd, t, part(askOf(PO_.dd, t), satSub(muldiv(w(W_.fd, t), reach, 65536), Math.min(rd, ard))));
    set(W_.share + PO_.dbg, t, part(askOf(PO_.dbg, t), muldiv(w(W_.bg, t), w(W_.barea, t), 65536)));
    set(W_.share + PO_.dbd, t, part(askOf(PO_.dbd, t), muldiv(w(W_.bd, t), w(W_.barea, t), 65536)));
    set(W_.share + PO_.dtw, t, part(askOf(PO_.dtw, t), muldiv(w(W_.tw, t), w(W_.tarea, t), 65536)));
    set(W_.share + PO_.strip, t, part(askOf(PO_.strip, t), smul(w(W_.stripg, t), 1000)));
    set(W_.share + PO_.shore, t, part(askOf(PO_.shore, t), smul(w(W_.shoreg, t), 1000)));
    set(W_.share + PO_.carr, t, part(askOf(PO_.carr, t), smul(w(W_.carr, t), 1000)));
  }
  // eat
  const ate = (p: number, t: number, v: number) => { A[A_.eat + p * T + t] = u(A[A_.eat + p * T + t] + v); };
  for (let i = 0; i < cap; i++) {
    if (!(b[i] & 1) || b[fo(F.held) + i] === 2) continue;
    const t = Q[Q_.pick * cap + i];
    if (t === NONE || Q[Q_.tgt * cap + i] !== NONE) continue;
    const s = b[fo(F.sp) + i] & 15, me = kg(G.me), med = kg(G.med), flesh = kg(G.flesh), a = [0, 1, 2, 3, 4].map((k) => Q[(Q_.a0 + k) * cap + i]), sh = (p: number) => w(W_.share + p, t);
    let j = 0;
    if (s === SP.deer) {
      const gg = mulq(a[0], sh(PO_.dg)), gd = mulq(a[1], sh(PO_.dd)), bg = mulq(a[2], sh(PO_.dbg)), bd = mulq(a[3], sh(PO_.dbd)), tw = mulq(a[4], sh(PO_.dtw));
      ate(PO_.dg, t, gg); ate(PO_.dd, t, gd); ate(PO_.dbg, t, bg); ate(PO_.dbd, t, bd); ate(PO_.dtw, t, tw);
      j = u(muldiv(gg, me, 1000) + muldiv(bg, w(W_.bq, t), 1000) + muldiv(u(gd + bd), med, 1000) + muldiv(tw, kg(G.twme), 1000));
    } else if (s === SP.rabbit) {
      const gg = mulq(a[0], sh(PO_.rg)), gd = mulq(a[1], sh(PO_.rd));
      ate(PO_.rg, t, gg); ate(PO_.rd, t, gd);
      j = u(muldiv(gg, me, 1000) + muldiv(gd, med, 1000));
    } else if (s === SP.fox || s === SP.eagle || s === SP.heron) {
      const p = s === SP.fox ? PO_.carr : s === SP.eagle ? PO_.water : PO_.strip, g = mulq(a[0], sh(p));
      ate(p, t, g); j = muldiv(g, flesh, 1000);
    } else if (s === SP.gull) {
      const c = mulq(a[0], sh(PO_.carr)), o = mulq(a[1], sh(PO_.shore));
      ate(PO_.carr, t, c); ate(PO_.shore, t, o); j = muldiv(u(c + o), flesh, 1000);
    } else if (s === SP.crow) {
      const c = mulq(a[0], sh(PO_.carr));
      ate(PO_.carr, t, c); j = muldiv(u(c + a[1]), flesh, 1000);
    }
    b[fo(F.e) + i] = u(fe(i) + i32(j));
  }
  // the packs
  for (let i = 0; i < cap; i++) {
    if (!(b[i] & 1) || b[fo(F.held) + i] === 2 || (b[fo(F.sp) + i] & 15) !== SP.wolf) continue;
    const grp = b[fo(F.grp) + i];
    if (grp === 0) continue;
    const pot = satAdd(A[packAt(PACK.pot, grp - 1)], A[larAt(cap) + grp - 1]), want = A[packAt(PACK.want, grp - 1)];
    if (pot === 0 || want === 0) continue;
    const e = fe(i), mine = u(Math.max(0, i32(kk(SP.wolf, K.full)) - e)), take = muldiv(Math.min(pot, want), mine, want);
    b[fo(F.e) + i] = u(e + i32(take));
    A[packAt(PACK.eaten, grp - 1)] = u(A[packAt(PACK.eaten, grp - 1)] + take);
  }
  for (let p = 0; p < cap; p++) {
    const pot = A[packAt(PACK.pot, p)], kept = A[larAt(cap) + p];
    if (pot === 0 && kept === 0) continue;
    const left = satSub(satAdd(pot, kept), A[packAt(PACK.eaten, p)]), killed = A[packAt(PACK.tile, p)], t1 = killed !== 0 ? killed : A[larAt(cap) + cap + p];
    if (A[packAt(PACK.n, p)] === 0) {
      if (t1 !== 0) A[A_.carr + t1 - 1] += Math.floor(left / kg(G.flesh));
      A[larAt(cap) + p] = 0; A[larAt(cap) + cap + p] = 0;
      continue;
    }
    A[larAt(cap) + p] = left; A[larAt(cap) + cap + p] = t1;
  }
  // settle
  const eat = (p: number, t: number) => A[A_.eat + p * T + t];
  for (let t = 0; t < T; t++) {
    if (w(W_.land, t) === 0) { const g = Math.floor(eat(PO_.water, t) / 1000); if (g > 0) A[A_.fish + t] += g; continue; }
    const ga = w(W_.garea, t);
    if (ga > 0) {
      set(W_.fg, t, satSub(w(W_.fg, t), muldiv(u(eat(PO_.rg, t) + eat(PO_.dg, t)), 65536, ga)));
      set(W_.fd, t, satSub(w(W_.fd, t), muldiv(u(eat(PO_.rd, t) + eat(PO_.dd, t)), 65536, ga)));
    }
    const ba = w(W_.barea, t);
    if (ba > 0) { set(W_.bg, t, satSub(w(W_.bg, t), muldiv(eat(PO_.dbg, t), 65536, ba))); set(W_.bd, t, satSub(w(W_.bd, t), muldiv(eat(PO_.dbd, t), 65536, ba))); }
    const ta = w(W_.tarea, t);
    if (ta > 0) set(W_.tw, t, satSub(w(W_.tw, t), muldiv(eat(PO_.dtw, t), 65536, ta)));
    set(W_.carr, t, satSub(w(W_.carr, t), Math.floor(u(eat(PO_.carr, t) + 999) / 1000)));
    const m2 = w(W_.stripm2, t);
    if (m2 > 0) set(W_.shore, t, satSub(w(W_.shore, t), muldiv(muldiv(eat(PO_.shore, t), kg(G.flesh), kg(G.shorej)), 65536, smul(m2, 1000))));
    const fg = Math.floor(eat(PO_.strip, t) / 1000), sg = w(W_.stripg, t);
    if (fg > 0 && sg > 0) for (let m = 0; m < 4; m++) {
      const j = w(W_.sw + m, t);
      if (j === NONE) continue;
      const g = muldiv(fg, mulq(w(W_.fish, j), w(W_.sa + m, t)), sg);
      if (g > 0) A[A_.fish + j] += g;
    }
  }
  // fate
  const spot = (t: number): [number, number] => [(t % TW) * TILE_MM + unif(TILE_MM), Math.floor(t / TW) * TILE_MM + unif(TILE_MM)];
  const matching = (t: number, run: number) => {
    const x = t % TW, y = Math.floor(t / TW), nb: number[] = [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if ((dx === 0 && dy === 0) || xx < 0 || yy < 0 || xx >= TW || yy >= TW) continue;
      if (w(W_.land, yy * TW + xx) === 1) nb.push(yy * TW + xx);
    }
    let tot = w(run, t);
    for (const j of nb) tot = u(tot + w(run, j));
    if (tot === 0) return t;
    let v = unif(tot);
    if (v < w(run, t)) return t;
    v -= w(run, t);
    for (const j of nb) { if (v < w(run, j)) return j; v -= w(run, j); }
    return t;
  };
  for (let i = 0; i < cap; i++) {
    Q[Q_.cnt * cap + i] = 0;
    if (!(b[i] & 1)) continue;
    const sw = b[fo(F.sp) + i], s = sw & 15, female = (sw >> 4) & 1, tick = pp(P.tick);
    rinit(pp(P.seed), STREAM.fate, i, tick);
    const full = kk(s, K.full), e = Math.min(fe(i), i32(full)), wolves = Math.min(A[A_.cen + SP.wolf], WTN - 1);
    const die = s === SP.wolf ? KP[WTAB + wolves] : kk(s, K.die), r = next32(), x = b[fo(F.x) + i], y = b[fo(F.y) + i];
    if (e < 0 || r < die) { b[i] &= ~1; A[A_.carr + tileOf(x, y)] += kk(s, K.kg); continue; }
    b[fo(F.e) + i] = u(e);
    const held = b[fo(F.held) + i];
    let hx = b[fo(F.hx) + i], hy = b[fo(F.hy) + i];
    if (held === 0) {
      let to: [number, number] = [x, y];
      if (s === SP.deer) to = spot(matching(tileOf(x, y), W_.pdeer));
      else if (s === SP.rabbit) {
        if (next32() < kk(s, K.move)) { const h = spot(matching(tileOf(hx, hy), W_.prabbit)); hx = h[0]; hy = h[1]; }
        const ox = unif(100001), oy = unif(100001);
        to = [Math.min(Math.max(0, hx + ox - 50000), TW * TILE_MM - 1), Math.min(Math.max(0, hy + oy - 50000), TW * TILE_MM - 1)];
      } else {
        let t = Q[Q_.pick * cap + i];
        const g = b[fo(F.grp) + i];
        if (s === SP.wolf && g > 0 && A[packAt(PACK.tile, g - 1)] !== 0) t = A[packAt(PACK.tile, g - 1)] - 1;
        if (t !== NONE) to = spot(t);
      }
      b[fo(F.x) + i] = to[0]; b[fo(F.y) + i] = to[1];
    }
    const age = u(tick - b[fo(F.born) + i]), mature = kk(s, K.mature), tps = pp(P.tps);
    if (age < 0x80000000 && age >= mature && age < mature + tps && next32() < kk(s, K.disp)) {
      const dr = kk(s, K.dreach), bx = dr !== 0 ? boxof(tileOf(hx, hy), dr) : [0, 0, TW - 1, TW - 1], t = anyland(bx);
      if (t !== NONE) { const h = spot(t); hx = h[0]; hy = h[1]; }
      if (s === SP.wolf) b[fo(F.grp) + i] = i + 1;
    } else if (s === SP.wolf && age < 0x80000000 && age >= mature && held !== 2) {
      let g = b[fo(F.grp) + i];
      if (g === 0) { g = i + 1; b[fo(F.grp) + i] = g; }
      const lone = A[A_.lone];
      if (female === 0 && lone !== 0 && A[packAt(PACK.fem, g - 1)] === 0) {
        const f = u(~lone);
        b[fo(F.grp) + i] = b[fo(F.grp) + f]; hx = b[fo(F.hx) + f]; hy = b[fo(F.hy) + f];
      }
    }
    if (hx !== b[fo(F.hx) + i] || hy !== b[fo(F.hy) + i]) { b[fo(F.hx) + i] = hx; b[fo(F.hy) + i] = hy; }
    if (female === 0 || age >= 0x80000000 || age < mature || held === 2) continue;
    // no breeding flags in the oracle's steps (checked above); a deer's rut is the only draw left
    const fit = muldiv(u(Math.max(e, 0)), 65536, full);
    if (s === SP.deer && pp(P.flags) & FLAG.rut && b[fo(F.preg) + i] === 0 && bern16(Math.min(kg(G.rutmax), u(kg(G.rutlo) + mulq(kg(G.rutsl), fit))))) b[fo(F.preg) + i] = 1;
  }
}

// ---------- a little island to run them on ----------
// Land on tiles 40 to 59 each way, water round it; a sward of 0.6 of each tile, all of it warren to half, and the
// drivers of a mild day every day of the year.
const LAND = (i: number) => { const x = i % TW, y = Math.floor(i / TW); return x >= 40 && x < 60 && y >= 40 && y < 60; };
const q16 = (x: number) => Math.round(x * 65536);
function islet(animals: { n: number; cols: Record<string, Uint32Array> }, consts: (per: number) => Uint32Array = (per) => lawConsts(per, { landKm2: 400 * 0.0225, shoreHa: 76 * 2.25 })): AnimalDriver {
  const tiles = new Uint32Array(STATIC_RUNS * T), pools = new Uint32Array((W_.wasbare - W_.fg + 1) * T), drivers = new Uint32Array(40 * DRIVERS * T), fish = new Uint32Array(T);
  for (let i = 0; i < T; i++) {
    for (let m = 0; m < 4; m++) tiles[(W_.sw + m) * T + i] = NONE;
    for (let d = 0; d < 40; d++) drivers[d * DRIVERS * T + DR.temp * T + i] = q16(10);
    if (!LAND(i)) { fish[i] = 60000; continue; }
    const g = q16(0.6);
    tiles[W_.land * T + i] = 1; tiles[W_.grass * T + i] = g; tiles[W_.lit * T + i] = q16(0.8); tiles[W_.warren * T + i] = q16(0.5);
    tiles[W_.garea * T + i] = Math.round((g * 22500 * 1000) / 65536);
    let m = 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const j = i + dy * TW + dx; if (!LAND(j)) { tiles[(W_.sw + m) * T + i] = j; tiles[(W_.sa + m) * T + i] = q16(0.2); m++; } }
    pools[i] = q16(150); pools[(W_.bg - W_.fg) * T + i] = q16(150);
    if (m) pools[(W_.shore - W_.fg) * T + i] = q16(27);
    for (let d = 0; d < 40; d++) {
      const at = d * DRIVERS * T;
      drivers[at + DR.grow * T + i] = q16(3); drivers[at + DR.leafk * T + i] = q16(0.05); drivers[at + DR.open * T + i] = 65536;
    }
  }
  return {
    seed: 7, days: 0, t0: 0, tiles: () => tiles, pools: () => pools, drivers: () => drivers, consts, start: () => animals,
    step: (t) => ({ day: Math.floor(t / 288) % 40, flags: 0, fish }), ate: () => {},
  };
}
// Animals laid out as columns: [species, female, tile x, tile y, reserve share, grp].
function laid(list: [number, number, number, number, number, number][]) {
  const cols: Record<string, number[]> = { x: [], y: [], sp: [], e: [], born: [], grp: [], hx: [], hy: [] };
  const full = lawConsts(24, { landKm2: 9, shoreHa: 171 });
  for (const [s, f, tx, ty, share, grp] of list) {
    const x = tx * TILE_MM + 75000, y = ty * TILE_MM + 75000;
    cols.x.push(x); cols.y.push(y); cols.hx.push(x); cols.hy.push(y); cols.sp.push(s | (f << 4));
    cols.e.push(Math.round(full[s * KW + K.full] * share) >>> 0); cols.born.push((-5 * 11520) >>> 0); cols.grp.push(grp);
  }
  return { n: list.length, cols: Object.fromEntries(Object.entries(cols).map(([k, v]) => [k, Uint32Array.from(v)])) };
}
// Steps the law on a GPU through the given ticks, reading back every body and the tiles after each; and the oracle
// from the same start.
async function run(g: Gpu, driver: AnimalDriver, ticks: number[], prep?: (g: Gpu, W: GPUBuffer) => void) {
  const s = new Store(g), host = new Animals();
  await host.attach(s, driver);
  const k = s.kind(ANIMAL), bufs = host.buffersForTest!, out: { b: Uint32Array; W: Uint32Array; A: Uint32Array }[] = [];
  prep?.(g, bufs.W);
  const start = { b: await s.read(ANIMAL, "body"), W: new Uint32Array(await readback(g, bufs.W)), A: new Uint32Array(await readback(g, bufs.A)), KP: new Uint32Array(await readback(g, bufs.KP)), D: new Uint32Array(await readback(g, bufs.D)) };
  for (const t of ticks) {
    await s.step(t);
    out.push({ b: await s.read(ANIMAL, "body"), W: new Uint32Array(await readback(g, bufs.W)), A: new Uint32Array(await readback(g, bufs.A)) });
  }
  host.destroy(); s.destroy();
  return { start, out, cap: k.capacity };
}
function oracleRun(start: { b: Uint32Array; W: Uint32Array; A: Uint32Array; KP: Uint32Array; D: Uint32Array }, cap: number, ticks: number[], driver: AnimalDriver) {
  const st: State = { cap, b: start.b.slice(), W: start.W.slice(), A: start.A.slice(), KP: start.KP.slice(), D: start.D };
  const outs: { b: Uint32Array; W: Uint32Array; A: Uint32Array }[] = [];
  for (const t of ticks) {
    const { day, flags, fish } = driver.step(t, 24);
    st.KP.set([t >>> 0, 24, day, flags, driver.seed, 12], PO);
    st.W.set(fish, W_.fish * T);
    oracleStep(st);
    outs.push({ b: st.b.slice(), W: st.W.slice(), A: st.A.slice() });
  }
  return outs;
}
const DAY_STEPS = Array.from({ length: 24 }, (_, k) => 288 + 12 * (k + 1));
const reserveOf = (b: Uint32Array, cap: number, i: number) => b[(F.e + 1) * cap + i] | 0;

test("a lone deer's day: its reserve, its place and its tile's sward each step equal the oracle's bit for bit, on both adapters", async () => {
  const driver = () => islet(laid([[SP.deer, 1, 50, 50, 0.5, 0]]));
  const hi = await run(await theGpu(), driver(), DAY_STEPS);
  const oracle = oracleRun(hi.start, hi.cap, DAY_STEPS, driver());
  const low = await openGpu("low-power"), lo = await run(low, driver(), DAY_STEPS);
  low.device.destroy();
  for (let k = 0; k < DAY_STEPS.length; k++) {
    expect(hi.out[k].b).toEqual(oracle[k].b);
    expect(hi.out[k].W).toEqual(oracle[k].W);
    expect(lo.out[k].b).toEqual(hi.out[k].b);
    expect(lo.out[k].W).toEqual(hi.out[k].W);
  }
  // the day's budget: it ate, it paid its field metabolic rate, and it is alive at the end
  const b = hi.out[23].b, cap = hi.cap;
  expect(b[0] & 1).toBe(1);
  const KP = hi.start.KP, fmr = KP[SP.deer * KW + K.fmr], e0 = reserveOf(hi.start.b, cap, 0), e1 = reserveOf(b, cap, 0);
  expect(e1).toBeGreaterThan(e0 - 24 * fmr);
  // what it ate is what left the sward: its tile's green fell by what it was asked for, as the oracle has it
  expect(hi.out[23].A.subarray(A_.eat, A_.eat + NPOOL * T)).toEqual(oracle[23].A.subarray(A_.eat, A_.eat + NPOOL * T));
}, 600_000);

test("a deer among bare broadleaves browses their year's twigs, standing from leaf fall: bit for bit with the oracle on both adapters", async () => {
  // every day leafless, and a fifth of every land tile broadleaf crown within reach (as the stems' raster would file it)
  const driver = () => {
    const d = islet(laid([[SP.deer, 1, 50, 50, 0.3, 0]])), D = d.drivers(), land = d.tiles();
    for (let k = 0; k < 40; k++) for (let i = 0; i < T; i++) if (land[W_.land * T + i]) D[k * DRIVERS * T + DR.bare * T + i] = 1;
    return d;
  };
  const share = Math.round(0.2 * 65536), area = Math.round((share * 22500 * 1000) / 65536);
  const prep = (g: Gpu, W: GPUBuffer) => {
    const runs = new Uint32Array(2 * T);
    for (let i = 0; i < T; i++) { const x = i % TW, y = Math.floor(i / TW); if (x >= 40 && x < 60 && y >= 40 && y < 60) { runs[i] = share; runs[T + i] = area; } }
    g.device.queue.writeBuffer(W, W_.twoody * T * 4, runs);
  };
  const hi = await run(await theGpu(), driver(), DAY_STEPS, prep);
  const oracle = oracleRun(hi.start, hi.cap, DAY_STEPS, driver());
  const low = await openGpu("low-power"), lo = await run(low, driver(), DAY_STEPS, prep);
  low.device.destroy();
  for (let k = 0; k < DAY_STEPS.length; k++) {
    expect(hi.out[k].b).toEqual(oracle[k].b);
    expect(hi.out[k].W).toEqual(oracle[k].W);
    expect(hi.out[k].A).toEqual(oracle[k].A);
    expect(lo.out[k].b).toEqual(hi.out[k].b);
    expect(lo.out[k].W).toEqual(hi.out[k].W);
  }
  // it browsed twigs, and the islet's twigs stand below what leaf fall set out on its 400 land tiles
  const twigsEaten = hi.out.reduce((n, o) => n + o.A.subarray(A_.eat + PO_.dtw * T, A_.eat + (PO_.dtw + 1) * T).reduce((a, x) => a + x, 0), 0);
  expect(twigsEaten).toBeGreaterThan(0);
  expect(hi.out[23].W.subarray(W_.tw * T, (W_.tw + 1) * T).reduce((a, x) => a + x, 0)).toBeLessThan(400 * hi.start.KP[GK + G.twig]);
}, 600_000);

test("two wolves of two packs claiming one deer: one gets it, the same one every run and on both adapters, as the oracle has it", async () => {
  // wolves sure to hunt (a rate past any prey's mass), hungry, beside the island's only deer
  const consts = (per: number) => { const c = lawConsts(per, { landKm2: 9, shoreHa: 171 }); c[SP.wolf * KW + K.rate] = NONE; return c; };
  const animals = () => laid([[SP.deer, 1, 50, 50, 0.5, 0], [SP.wolf, 0, 49, 50, 0.2, 2], [SP.wolf, 1, 51, 50, 0.2, 3]]);
  const ticks = [300];
  const runs: Uint32Array[] = [];
  for (let k = 0; k < 3; k++) runs.push((await run(await theGpu(), islet(animals(), consts), ticks)).out[0].b);
  const low = await openGpu("low-power"), lo = await run(low, islet(animals(), consts), ticks);
  low.device.destroy();
  const hi = await run(await theGpu(), islet(animals(), consts), ticks), oracle = oracleRun(hi.start, hi.cap, ticks, islet(animals(), consts));
  for (const r of runs) expect(r).toEqual(hi.out[0].b);
  expect(lo.out[0].b).toEqual(hi.out[0].b);
  expect(hi.out[0].b).toEqual(oracle[0].b);
  expect(hi.out[0].A).toEqual(oracle[0].A);
  const cap = hi.cap, b = hi.out[0].b;
  // the deer is dead, killed once: one pack's pot holds it, the other's nothing
  expect(b[0] & 1).toBe(0);
  const pot = (grp: number) => hi.out[0].A[A_.claim + cap * (1 + PACK.pot) + grp - 1];
  expect([pot(2) > 0, pot(3) > 0].filter(Boolean).length).toBe(1);
  // the winner ate from its pack's pot and the loser didn't
  const gained = [1, 2].map((i) => reserveOf(b, cap, i) - reserveOf(hi.start.b, cap, i));
  expect(gained.filter((x) => x > 0).length).toBe(1);
}, 600_000);

test("a pack keeps what it leaves of a kill and comes back to it, and a lone male goes to the lone she-wolf: bit for bit with the oracle on both adapters", async () => {
  // a pair sure to kill (a rate past any prey's mass), hungry, beside the island's only deer; a grown she-wolf and a
  // grown male apart, each the only wolf of its pack, full so they don't hunt
  const consts = (per: number) => { const c = lawConsts(per, { landKm2: 9, shoreHa: 171 }); c[SP.wolf * KW + K.rate] = NONE; return c; };
  const animals = () => laid([[SP.deer, 1, 50, 50, 0.5, 0], [SP.wolf, 0, 49, 50, 0.2, 2], [SP.wolf, 1, 51, 50, 0.2, 2], [SP.wolf, 1, 45, 45, 1, 4], [SP.wolf, 0, 55, 55, 1, 5]]);
  const ticks = [300, 312, 324, 336];
  const hi = await run(await theGpu(), islet(animals(), consts), ticks), oracle = oracleRun(hi.start, hi.cap, ticks, islet(animals(), consts));
  const low = await openGpu("low-power"), lo = await run(low, islet(animals(), consts), ticks);
  low.device.destroy();
  for (let k = 0; k < ticks.length; k++) {
    expect(hi.out[k].b).toEqual(oracle[k].b);
    expect(hi.out[k].A).toEqual(oracle[k].A);
    expect(lo.out[k].b).toEqual(hi.out[k].b);
    expect(lo.out[k].A).toEqual(hi.out[k].A);
  }
  const cap = hi.cap, larder = (k: number) => hi.out[k].A[larAt(cap) + 1];
  // the pair killed the deer, ate their fill and kept the rest, which they eat down in the hours after
  expect(hi.out[0].b[0] & 1).toBe(0);
  expect(larder(0)).toBeGreaterThan(0);
  expect(larder(1)).toBeLessThan(larder(0));
  // the lone male joined the she-wolf's pack and took her home for his
  const b = hi.out[0].b, f = (fd: number, i: number) => b[(fd + 1) * cap + i];
  expect(f(F.grp, 4)).toBe(4);
  expect([f(F.hx, 4), f(F.hy, 4)]).toEqual([f(F.hx, 3), f(F.hy, 3)]);
}, 600_000);

test("every kind together for a few hours: grazing, hunting, scavenging, fishing and the shore, bit for bit with the oracle on both adapters", async () => {
  const kinds: [number, number, number, number, number, number][] = [];
  for (let k = 0; k < 6; k++) {
    kinds.push([SP.rabbit, k & 1, 45 + k, 45, 0.6, 0], [SP.rabbit, 1, 45 + k, 46, 0.3, 0], [SP.deer, k & 1, 50, 44 + k, 0.4, 0]);
    kinds.push([SP.gull, k & 1, 40, 40 + k, 0.5, 0], [SP.crow, k & 1, 42 + k, 42, 0.5, 0], [SP.heron, 1, 59, 50 + k, 0.5, 0]);
  }
  kinds.push([SP.fox, 0, 46, 46, 0.3, 0], [SP.fox, 1, 47, 45, 0.2, 0], [SP.eagle, 1, 50, 50, 0.2, 0], [SP.wolf, 1, 50, 45, 0.3, 4], [SP.wolf, 0, 51, 45, 0.3, 4]);
  const ticks = [300, 312, 324, 336];
  const hi = await run(await theGpu(), islet(laid(kinds)), ticks), oracle = oracleRun(hi.start, hi.cap, ticks, islet(laid(kinds)));
  const low = await openGpu("low-power"), lo = await run(low, islet(laid(kinds)), ticks);
  low.device.destroy();
  for (let k = 0; k < ticks.length; k++) {
    expect(hi.out[k].b).toEqual(oracle[k].b);
    expect(hi.out[k].W).toEqual(oracle[k].W);
    expect(hi.out[k].A).toEqual(oracle[k].A);
    expect(lo.out[k].b).toEqual(hi.out[k].b);
  }
}, 600_000);

test("the constants: every species' reserve, rate and step deaths are set, and no step's burn passes a full reserve", () => {
  const c = lawConsts(24, { landKm2: 220, shoreHa: 3000 });
  for (let s = 0; s < NSP; s++) {
    expect(c[s * KW + K.full]).toBeGreaterThan(0);
    expect(c[s * KW + K.fmr]).toBeLessThan(c[s * KW + K.full]);
    expect(c[s * KW + K.die]).toBeGreaterThan(0);
  }
  expect(c[CLS + 32 + 2]).toBe(11000);
  expect(c[GK + G.flesh]).toBe(3080);
});
