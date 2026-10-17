// What lies near a burning bed taking its heat and its brands, on the GPU (law: wgsl/fire.ts; plan
// docs/plans/2026-10-14-001-refactor-gpu-object-world-plan.md, Unit 12; docs/research/fire-constants.md sec. 36).
// Each tick src/sim/ecology.ts fire burns the beds on the CPU, look by look, and packs what every bed's blaze was at
// each look and every fuel object within reach of one (src/sim/spread.ts blazeWords, receiverWords) into a batch; the
// batch goes to the GPU with the tick's landing, and the receivers' heat and lighting come back with it, when the CPU
// makes each thing that lit a bed of its own. This module's twin, receive, is the law's TypeScript oracle, word for
// word; a world that isn't resident on the GPU (one a test or a tool steps by hand) runs its batches through it.
import { cover } from "./kernel";
import { divw, mul64, qadd, qdiv, qln, qmul } from "./fixed";
import { isqrt64, qpoisson, qunif, rinit } from "./rand";
import type { Rider, Store } from "./store";
import { B, BW, BY, DIR_BITS, HEAT, INTO, LEAST_Q, LIM, LIT, LOOK_S, NONE, PT, PW, R, RW, STREAM, TOGETHER, fireReceive } from "./wgsl/fire";

// A tick's batch: the world's seed and the tick, and its words: where each look's blazes start (looks + 1 words),
// the blazes (BW words each), the receivers (RW each) and their parts (PW each); and how many of each.
export type Batch = { seed: number; tick: number; looks: number; nr: number; np: number; offB: number; offR: number; offP: number; words: Uint32Array };
// A batch from each look's blazes (BW numbers each), the receivers (RW numbers each, parts' starts and counts laid in
// here) and each receiver's parts (PW numbers each).
export function pack(seed: number, tick: number, looks: number[][][], receivers: { words: number[]; parts: number[][] }[]): Batch {
  const nb = looks.reduce((n, l) => n + l.length, 0), nr = receivers.length, np = receivers.reduce((n, r) => n + r.parts.length, 0);
  const offB = looks.length + 1, offR = offB + nb * BW, offP = offR + nr * RW, words = new Uint32Array(offP + np * PW);
  let j = 0, p = 0;
  looks.forEach((l, k) => { words[k] = j; for (const b of l) words.set(b.map((v) => v >>> 0), offB + BW * j++); });
  words[looks.length] = j;
  receivers.forEach((r, i) => {
    const w = r.words.map((v) => v >>> 0);
    w[R.p0] = p; w[R.np] = r.parts.length;
    words.set(w, offR + RW * i);
    for (const part of r.parts) words.set(part.map((v) => v >>> 0), offP + PW * p++);
  });
  return { seed: seed >>> 0, tick: tick >>> 0, looks: looks.length, nr, np, offB, offR, offP, words };
}

// ---------- the twin ----------
// The landing's words for a batch: a status word a receiver (LIT, the look in bits 24 to 30, the bed's index), then
// each part's heat (Q8 kJ/m2) with its lit bit.
export function receive(b: Batch): Uint32Array {
  const inp = b.words, out = new Uint32Array(b.nr + b.np), acc = new Int32Array(b.np);
  const bw = (j: number, f: number) => inp[b.offB + j * BW + f] | 0, rw = (r: number, f: number) => inp[b.offR + r * RW + f], pw = (p: number, f: number) => inp[b.offP + p * PW + f];
  const sq = (v: number) => (v * v) >>> 0;
  const along = (px: number, pz: number, tx: number, tz: number) => {
    const l2 = tx * tx + tz * tz;
    let s = 0;
    if (l2 > 0) {
      const dot = px * tx + pz * tz;
      if (dot >= l2) s = 65536;
      else if (dot > 0) s = divw(dot >>> 16, (dot << 16) >>> 0, l2)[0];
    }
    return (sq(px - ((s * tx) >> 16)) + sq(pz - ((s * tz) >> 16))) >>> 0;
  };
  const up = (px: number, pz: number, a: number, lo: number, hi: number) => (sq(px - a) + sq(pz - Math.min(hi, Math.max(lo, pz)))) >>> 0;
  const apart2 = (tx: number, tz: number, a: number, lo: number, hi: number) => {
    if (tx > 0 && a >= 0 && a <= tx) { const z = Math.trunc((a * tz) / tx); if (z >= lo && z <= hi) return 0; }
    if (tx === 0 && a === 0 && hi >= 0 && lo <= tz) return 0;
    return Math.min(along(a, lo, tx, tz), along(a, hi, tx, tz), up(0, 0, a, lo, hi), up(tx, tz, a, lo, hi));
  };
  const fluxOn = (j: number, p: number, a: number, c: number) => {
    const lo = pw(p, PT.lo) | 0, hi = pw(p, PT.hi) | 0, tx = bw(j, B.tx), tz = bw(j, B.tz), rb = bw(j, B.rb);
    if (bw(j, B.lf) > 0 && Math.abs(c) < rb && apart2(tx, tz, a, lo, hi) <= sq(rb) - sq(c)) return qadd(pw(p, PT.contact) | 0, bw(j, B.fr));
    const z = Math.min(hi, Math.max(lo, tz >> 1)), heap = bw(j, B.heap);
    let r2 = Math.max((sq(a - (tx >> 1)) + sq(c) + sq(z - (tz >> 1))) >>> 0, sq(heap));
    if (r2 === 0) r2 = 1;
    const q = mul64(bw(j, B.qr) >>> 0, 655360);
    if (q[1] >= r2) return 0x7fffffff;
    return Math.min(divw(q[1], q[0], r2)[0], 0x7fffffff);
  };
  const flight = (j: number, z: number) => {
    let kf = bw(j, B.k);
    if (bw(j, B.wind) !== 0) {
      const zz = Math.max(z, 5, bw(j, B.v));
      kf = qmul(kf, qmul(Math.max(0, qln(qdiv(((zz << 16) - bw(j, B.s)) | 0, bw(j, B.d)))), bw(j, B.inv)));
    }
    const p = mul64(z >>> 0, kf >>> 0);
    return ((p[0] >>> 16) | (p[1] << 16)) | 0;
  };
  const lofted = (j: number, x: number) => {
    if (x <= 0) return 0;
    const alive = bw(j, B.alive);
    if (flight(j, alive) <= x) return alive;
    let lo = 0, hi = alive;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (flight(j, mid) < x) lo = mid; else hi = mid - 1; }
    return lo;
  };
  const reaches = (heat: number, net: number, thin: number, deep: number) => {
    if (heat >= thin || thin === 0 || deep === 0) return true;
    const x = divw(heat >>> 16, (heat << 16) >>> 0, thin)[0], p = mul64(heat, net);
    if (p[1] >= deep) return true;
    const y = divw(p[1], p[0], deep)[0];
    if (y >= 65536) return true;
    const x2 = Math.floor((x * x) / 65536), y2 = Math.floor((y * y) / 65536);
    return Math.floor((x2 * x2) / 65536) + Math.floor((y2 * y2) / 65536) >= 65536;
  };
  const scaled = (v: number, num: number, den: number) => { const m = Math.floor((Math.abs(v) * num) / den); return v < 0 ? -m : m; };
  const looks = b.looks, nr = b.nr;
  for (let r = 0; r < nr; r++) {
    const rx = rw(r, R.x) | 0, ry = rw(r, R.y) | 0, hw = rw(r, R.half) | 0, p0 = rw(r, R.p0), np = rw(r, R.np), tinder = rw(r, R.tinder);
    for (let p = p0; p < p0 + np; p++) out[nr + p] = pw(p, PT.heat);
    out[r] = 0;
    looking: for (let k = 0; k < looks; k++) {
      for (let p = p0; p < p0 + np; p++) acc[p] = 0;
      let most = -1, byHeat = NONE, mean = 0, mostB = 0, byBrand = NONE;
      for (let j = inp[k]; j < inp[k + 1]; j++) {
        const ex = rx - bw(j, B.x), ey = ry - bw(j, B.y);
        if (Math.abs(ex) >= LIM || Math.abs(ey) >= LIM) continue;
        const dx = bw(j, B.dx), dy = bw(j, B.dy), lim = bw(j, B.reach) + hw;
        if (Math.abs(ex) <= lim && Math.abs(ey) <= lim) {
          const d = isqrt64([(sq(ex) + sq(ey)) >>> 0, 0]);
          if (d <= lim) {
            let a = 0, c = 0;
            if (d > hw) { a = scaled((ex * dx + ey * dy) >> DIR_BITS, d - hw, d); c = scaled((ey * dx - ex * dy) >> DIR_BITS, d - hw, d); }
            let sum = 0;
            for (let p = p0; p < p0 + np; p++) { const f = fluxOn(j, p, a, c); acc[p] = qadd(acc[p], f); sum = qadd(sum, f); }
            if (sum > most) { most = sum; byHeat = bw(j, B.bed) >>> 0; }
          }
        }
        const rb = bw(j, B.rb);
        if (hw > 0 && bw(j, B.gb) !== 0 && rb > 0 && bw(j, B.lf) > 0) {
          const a = (ex * dx + ey * dy) >> DIR_BITS, c = (ey * dx - ex * dy) >> DIR_BITS, over = Math.min(c + hw, rb) - Math.max(c - hw, -rb);
          if (over > 0) {
            const dz = lofted(j, a + hw) - lofted(j, a - hw);
            if (dz > 0) {
              const q = mul64(bw(j, B.gb) >>> 0, over * dz), m = q[1] < 0x8000 ? ((q[0] >>> 16) | (q[1] << 16)) | 0 : 0x7fffffff;
              mean = qadd(mean, m);
              if (m > mostB) { mostB = m; byBrand = bw(j, B.bed) >>> 0; }
            }
          }
        }
      }
      let lit = false;
      for (let p = p0; p < p0 + np; p++) {
        const into = Math.min(acc[p], INTO), net = into - (pw(p, PT.loss) | 0);
        const heat = Math.min(HEAT, Math.max(0, (out[nr + p] & 0x7fffffff) + ((net * LOOK_S) >> 8)));
        let h = heat;
        if (into >= LEAST_Q && pw(p, PT.ok) !== 0 && net > 0 && reaches(heat, net, pw(p, PT.thin), pw(p, PT.deep))) { h = (h | LIT) >>> 0; lit = true; }
        out[nr + p] = h;
      }
      if (lit) { out[r] = (LIT | (k << 24) | (byHeat & BY)) >>> 0; break looking; }
      if (mean > 0 && tinder !== NONE) {
        rinit(b.seed, (STREAM + k) >>> 0, rw(r, R.key), b.tick);
        if (qpoisson(mean) >= TOGETHER && qunif() < (rw(r, R.odds) | 0)) {
          out[nr + p0 + tinder] = (out[nr + p0 + tinder] | LIT) >>> 0;
          out[r] = (LIT | (k << 24) | (byBrand & BY)) >>> 0;
          break looking;
        }
      }
    }
  }
  return out;
}

// ---------- the GPU ----------
// The receivers riding a world's store: a batch queued on a landing tick (the looks of the fire's runs since the last
// landing, src/sim/ecology.ts fire) goes to the GPU with that landing, and what comes back is handed to the batch's
// done. A batch still queued when the next is (a caller stepping fire without landing the store between) is worked out
// by the twin first, which gives the same words.
type Queued = { b: Batch; done: (out: Uint32Array) => void };
export class Receivers implements Rider {
  store: Store | null = null;
  private src = "";
  private queued: Queued | null = null;
  private sent: Queued | null = null;

  attach(store: Store) {
    if (this.store) throw new Error("the fire's receivers already ride a store");
    this.store = store;
    this.src = fireReceive();
    store.ride(this);
  }
  kernelSources(): string[] { return [this.src]; }
  queue(b: Batch, done: (out: Uint32Array) => void) {
    const was = this.queued;
    this.queued = { b, done };
    if (was) was.done(receive(was.b));
  }

  // ---------- riding the store ----------
  words(): number {
    this.sent = this.queued;
    this.queued = null;
    return this.sent ? this.sent.b.nr + this.sent.b.np : 0;
  }
  record(out: GPUBuffer, at: number) {
    const q = this.sent;
    if (!q) return;
    const s = this.store!, b = q.b, inp = s.scratch("fireinput", b.words.length), acc = s.scratch("fireacc", b.np);
    s.g.device.queue.writeBuffer(inp, 0, b.words);
    s.run(this.src, [inp, acc, out], cover(s.g, b.nr, 64), [at, b.nr, b.looks, b.tick, b.seed, b.offB, b.offR, b.offP]);
  }
  land(o: Uint32Array, at: number) {
    const q = this.sent;
    if (!q) return;
    this.sent = null;
    q.done(o.slice(at, at + q.b.nr + q.b.np));
  }
}
