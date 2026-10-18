// The fire on the GPU: the beds burning (law: wgsl/beds.ts) and what lies near them taking their heat and their brands
// (law: wgsl/fire.ts); plan docs/plans/2026-10-14-001-refactor-gpu-object-world-plan.md, Unit 12;
// docs/research/fire-constants.md secs. 36 and 37.
// Every bed the world has burning holds a slot of the beds' state on the GPU. Each run of the fire lane
// src/sim/ecology.ts fire gives every bed one look on the GPU, in the air it stands in (a submit of its own, read back
// at the start of the next tick): each bed's state comes back as the bed everyone reads (what its flame stands, what
// heat it gives, what coals it holds), with the blaze it gave and how far its heat and its brands reached. At a landing
// the blazes of the looks since the last, every fuel object within reach of one (src/sim/spread.ts receiverWords) and its
// parts go to the GPU with the store's landing, where the receivers take those blazes' heat and brands; each receiver's
// heat and lighting come back with it, and the CPU makes each thing that lit a bed of its own.
// The twins are the laws' TypeScript oracles for the tests, word for word: receive the receivers', and burnBeds the beds'
// (by src/sim/combustion.ts burnFor and spread.ts blazing and blazeWords); no world runs by them.
import { cover, dispatch, pipelineSoon, readback, storage, uniform } from "./kernel";
import { divw, mul64, qadd, qdiv, qln, qmul } from "./fixed";
import { isqrt64, qpoisson, qunif, rinit } from "./rand";
import { T, bits, real } from "./real";
import type { Rider, Store } from "./store";
import { B, BW, BY, DIR_BITS, HEAT, INTO, LEAST_Q, LIM, LIT, LOOK_S, NONE, NOWHERE, PT, PW, R, RW, STREAM, TOGETHER, fireReceive } from "./wgsl/fire";
import { AF, AW, BEDW, CF, CW, GF, GW, H, HW, SF, SW, fireBeds } from "./wgsl/beds";
import { COALS, GROUPS, alight, burnFor, copyBed, lawOf, output, type Air, type Bed, type LawAir } from "../sim/combustion";
import { blazeWords, blazing } from "../sim/spread";
import type { Phys } from "../sim/fuel";

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

// ---------- the beds' words ----------
// A bed's state as the beds' law holds it (wgsl/beds.ts), each group's record numbered by its place in phys (records not
// in phys yet are added to it). Every number is a real; a bed past the law's bounds (combustion.ts GROUPS, COALS) is
// refused.
export function bedWords(b: Bed, phys: Phys[] = []): Uint32Array {
  if (b.groups.length > GROUPS || b.coals.length > COALS) throw new Error(`a bed of ${b.groups.length} groups and ${b.coals.length} lots of coals is past the beds' law's ${GROUPS} and ${COALS}`);
  const w = new Uint32Array(BEDW), r = (x: number) => bits(T(x));
  w[H.ng] = b.groups.length; w[H.nc] = b.coals.length; w[H.age] = r(b.age);
  b.groups.forEach((g, i) => {
    const p = lawOf(g.phys), o = HW + i * GW;
    let pid = phys.indexOf(g.phys);
    if (pid < 0) pid = phys.push(g.phys) - 1;
    w[o + GF.d] = r(p.d); w[o + GF.pm] = r(p.mass); w[o + GF.rho] = r(p.rho); w[o + GF.c] = r(p.c); w[o + GF.L] = r(p.L); w[o + GF.cy] = r(p.cy);
    w[o + GF.tig] = r(p.tig); w[o + GF.krc] = r(p.krc); w[o + GF.qcr] = r(p.qcr); w[o + GF.fl] = r(p.flame); w[o + GF.share] = r(p.share); w[o + GF.pid] = pid;
    w[o + GF.n] = r(g.n); w[o + GF.mass] = r(g.mass); w[o + GF.m] = r(g.m); w[o + GF.skin] = r(g.skin ?? g.m); w[o + GF.lit] = g.lit ? 1 : 0;
    w[o + GF.since] = r(g.since); w[o + GF.ring] = r(g.ring); w[o + GF.heat] = r(g.heat); w[o + GF.warm] = r(g.warm); w[o + GF.cover] = r(g.cover); w[o + GF.inside] = r(g.inside);
  });
  b.coals.forEach((c, i) => {
    const o = HW + GROUPS * GW + i * CW;
    w[o + CF.ring] = r(c.ring); w[o + CF.kg] = r(c.kg); w[o + CF.d] = r(c.d); w[o + CF.rho] = r(c.rho);
  });
  return w;
}
// The bed a state's words hold, its groups' records from phys by number.
export function bedFrom(w: Uint32Array, phys: Phys[]): Bed {
  const groups = Array.from({ length: w[H.ng] }, (_, i) => {
    const o = HW + i * GW, at = (f: number) => real(w[o + f]), m = at(GF.m), skin = at(GF.skin);
    return {
      phys: phys[w[o + GF.pid]], n: at(GF.n), mass: at(GF.mass), m, ...(skin === m ? {} : { skin }), lit: w[o + GF.lit] !== 0, since: at(GF.since),
      ring: at(GF.ring), heat: at(GF.heat), warm: at(GF.warm), cover: at(GF.cover), inside: at(GF.inside),
    };
  });
  const coals = Array.from({ length: w[H.nc] }, (_, i) => {
    const o = HW + GROUPS * GW + i * CW;
    return { ring: real(w[o + CF.ring]), kg: real(w[o + CF.kg]), d: real(w[o + CF.d]), rho: real(w[o + CF.rho]) };
  });
  return { groups, coals, age: real(w[H.age]) };
}
// The air at a bed at a look as the law reads it, with the bed's place (cm) and the wind's way (Q13) as a blaze's words
// hold them (spread.ts placeWords).
export function airWords(a: Air, place: { x: number; y: number; dx: number; dy: number }): Uint32Array {
  const w = new Uint32Array(AW), r = (x: number) => bits(T(x));
  w[AF.on] = 1; w[AF.temp] = r(a.temp); w[AF.wind] = r(a.wind); w[AF.rain] = r(a.rain); w[AF.veg] = r(a.veg ?? 0); w[AF.blown] = r(a.blown ?? 0);
  if (a.ring) { w[AF.tall] = r(a.ring.tall); w[AF.width] = r(a.ring.width); w[AF.ringed] = 1; }
  w[AF.covered] = a.covered ? 1 : 0; w[AF.held] = r(a.held ?? 0);
  w[AF.x] = place.x >>> 0; w[AF.y] = place.y >>> 0; w[AF.dx] = place.dx >>> 0; w[AF.dy] = place.dy >>> 0;
  return w;
}
const airFrom = (w: Uint32Array): LawAir => ({
  temp: real(w[AF.temp]), wind: real(w[AF.wind]), rain: real(w[AF.rain]), veg: real(w[AF.veg]), blown: real(w[AF.blown]),
  covered: w[AF.covered] !== 0, held: real(w[AF.held]), ...(w[AF.ringed] ? { ring: { tall: real(w[AF.tall]), width: real(w[AF.width]) } } : {}),
});

// ---------- a run of looks ----------
// A bed's part in a run of looks: its slot, the bed as the CPU has it, whether the CPU changed it since the GPU last had
// it, and the air at each of the run's looks (null for a look it doesn't take: one before it was lit).
export type BedJob = { slot: number; bed: Bed; fresh: boolean; airs: (Uint32Array | null)[] };
// What comes back of a run: each bed as it stands after its looks, the look it went out at (0 for none, else one more
// than the look), the farthest its heat and its brands reached (cm); and every blaze (BW words each, look by look, a
// look's beds in the beds' order).
export type Burned = { beds: { bed: Bed; gone: number; reach: number; far: number }[]; blazes: Uint32Array };
// A blaze's words where a bed doesn't blaze at a look.
export const NO_BLAZE: readonly number[] = Array.from({ length: BW }, (_, f) => (f === B.x ? NOWHERE : 0));

// The beds' twin: each bed through its looks as wgsl/beds.ts takes it, the test's oracle for the kernel.
export function burnBeds(jobs: BedJob[], looks: number): Burned {
  const nb = jobs.length, blazes = new Uint32Array(looks * nb * BW);
  const beds = jobs.map((job, j) => {
    const bed = copyBed(job.bed), s = { bed, gone: 0, reach: 0, far: 0 };
    for (let k = 0; k < looks; k++) {
      const at = (k * nb + j) * BW, a = job.airs[k];
      blazes.set(NO_BLAZE, at);
      if (!a || s.gone) continue;
      const air = airFrom(a);
      if (alight(bed) && !air.covered) {
        const v = blazeWords({ px: 0, py: 0, dx: 0, dy: 0, ...blazing(output(bed, air), air) }, j, { x: a[AF.x] | 0, y: a[AF.y] | 0, dx: a[AF.dx] | 0, dy: a[AF.dy] | 0 });
        blazes.set(v.map((x) => x >>> 0), at);
        s.reach = Math.max(s.reach, v[B.reach]);
        s.far = Math.max(s.far, v[B.far]);
      }
      burnFor(bed, STEP_S, air);
      if (!alight(bed)) s.gone = k + 1;
    }
    return s;
  });
  return { beds, blazes };
}
const STEP_S = T(LOOK_S);

// ---------- the GPU ----------
// The fire riding a world's store, in two parts.
// The beds burn on their own submit: each run of the fire lane (every look, ten seconds) gives look the beds, each with
// the air it stands in, and the beds' kernel runs their look on the GPU and reads each bed's state, the blaze it gave and
// how far it reached back, small enough (a few kilobytes a bed) to be read at the start of the next tick (arrive), so what
// anyone reads of a bed is at most a look old. The beds' state stays on the GPU between runs, a slot a bed (slotOf, keep);
// a bed's state goes up only where the GPU doesn't hold it as the CPU has it (new, fed or kindled since).
// The receivers take the blazes of the looks since the last landing with the store's landing: work queued on a landing
// tick goes to the GPU with it, and what comes back is handed to the work's done. Work still queued when the next is
// queued is a caller's mistake (the store lands between two).
// The beds' kernel is the largest the world has (its first compile takes Chrome 38 s and Bun's Dawn 24 s on the AMD
// adapter, fire-constants sec. 37), so it is named in kernelSources like the rest and set compiling with them by the first
// paced begin; a look that reaches it before it is made waits for it (a tick waits at arrive), as the browser's frames go
// on.
type Queued = { batch: Batch; done: (receivers: Uint32Array) => void };
type Flight = { got: Promise<Burned>; done: (got: Burned) => void };
export class Fire implements Rider {
  store: Store | null = null;
  private srcBeds = "";
  private srcRecv = "";
  private queued: Queued | null = null;
  private sent: Queued | null = null;
  private flight: Flight | null = null;
  // the beds' state, and the scratch of a run of looks (each grown as a run needs)
  private state: GPUBuffer | null = null;
  private readonly bufs = new Map<string, GPUBuffer>();
  // the slots held, by what holds them; slots let go; the slots whose state the GPU holds as the CPU last had it, and
  // the records the words of each slot's state number
  private readonly slots = new Map<object, number>();
  private readonly free: number[] = [];
  private readonly held = new Set<number>();
  private readonly phys = new Map<number, Phys[]>();

  attach(store: Store) {
    if (this.store) throw new Error("the fire already rides a store");
    this.store = store;
    this.srcBeds = fireBeds();
    this.srcRecv = fireReceive();
    store.ride(this);
  }
  kernelSources(): string[] { return [this.srcRecv, this.srcBeds]; }
  // The slot a bed holds, by what holds it (a burning thing).
  slotOf(key: object): number {
    let s = this.slots.get(key);
    if (s === undefined) { s = this.free.pop() ?? this.slots.size; this.slots.set(key, s); this.held.delete(s); }
    return s;
  }
  // Every slot not held by one of these let go.
  keep(keys: Set<object>) {
    for (const [k, s] of this.slots) if (!keys.has(k)) { this.slots.delete(k); this.free.push(s); this.held.delete(s); this.phys.delete(s); }
  }
  // A buffer of at least so many words, kept and grown as runs need.
  private scratch(name: string, words: number): GPUBuffer {
    let b = this.bufs.get(name);
    if (!b || b.size < words * 4) {
      b?.destroy();
      b = storage(this.store!.g, Math.max(words, 1) * 4);
      this.bufs.set(name, b);
    }
    return b;
  }
  // Lets go of every buffer the fire held; the store's own are the store's.
  destroy() {
    this.state?.destroy();
    for (const b of this.bufs.values()) b.destroy();
    this.state = null;
    this.bufs.clear();
    this.held.clear();
  }

  // ---------- the beds ----------
  // Sets so many looks of these beds running, one on the GPU at a time; done is handed what comes back by arrive.
  look(jobs: BedJob[], looks: number, done: (got: Burned) => void) {
    if (this.flight) throw new Error("the beds' last looks have not been taken yet");
    this.flight = { got: this.burn(jobs, looks), done };
  }
  // Whether looks are on their way.
  get flying(): boolean { return this.flight !== null; }
  // Waits for the looks on their way and hands what they bring to the done they were set with: the one place a bed
  // changes by the GPU's work, at the start of a tick.
  async arrive() {
    const f = this.flight;
    if (!f) return;
    this.flight = null;
    f.done(await f.got);
  }
  // So many looks of these beds, run on the GPU in a submit of their own and read back. Whatever the GPU did, the
  // CPU's copy of a bed is only changed by the one who takes the result.
  async burn(jobs: BedJob[], looks: number): Promise<Burned> {
    const g = this.store!.g, nb = jobs.length, soon = pipelineSoon(g, this.srcBeds), pipe = soon instanceof Promise ? await soon : soon;
    const slots = Math.max(64, ...jobs.map((b) => b.slot + 1));
    // a state buffer made again holds nothing yet
    if (!this.state || this.state.size < slots * BEDW * 4) {
      this.state?.destroy();
      this.state = storage(g, slots * BEDW * 4);
      this.held.clear();
    }
    for (const b of jobs) {
      if (!b.fresh && this.held.has(b.slot)) continue;
      const phys: Phys[] = [];
      g.device.queue.writeBuffer(this.state, b.slot * BEDW * 4, bedWords(b.bed, phys));
      this.phys.set(b.slot, phys);
    }
    const phys = jobs.map((b) => this.phys.get(b.slot)!);
    const job = new Uint32Array(nb + looks * nb * AW);
    jobs.forEach((b, j) => {
      job[j] = b.slot;
      for (let k = 0; k < looks; k++) { const a = b.airs[k]; if (a) job.set(a, nb + (k * nb + j) * AW); }
    });
    const jb = this.scratch("job", job.length), fin = this.scratch("blazes", looks * nb * BW), words = nb * (SW + BEDW + looks * BW), out = this.scratch("out", words);
    g.device.queue.writeBuffer(jb, 0, job);
    const params = uniform(g, Uint32Array.from([0, nb, looks, 0, nb, 32, 0, 0]));
    dispatch(g, pipe, [this.state, jb, fin, out, params], cover(g, nb, 64));
    const o = new Uint32Array(await readback(g, out, words * 4)), ob = nb * (SW + BEDW);
    params.destroy();
    return {
      beds: jobs.map((b, j) => {
        const s = j * SW, w = o.subarray(nb * SW + j * BEDW, nb * SW + (j + 1) * BEDW);
        this.held.add(b.slot);
        return { bed: bedFrom(w, phys[j]), gone: o[s + SF.gone], reach: o[s + SF.reach], far: o[s + SF.far] };
      }),
      blazes: o.slice(ob, ob + looks * nb * BW),
    };
  }

  // ---------- the receivers, riding the store ----------
  queue(batch: Batch, done: (receivers: Uint32Array) => void) {
    if (this.queued) throw new Error("the fire has work queued already: the store lands between two");
    this.queued = { batch, done };
  }
  words(): number {
    this.sent = this.queued;
    this.queued = null;
    return this.sent ? this.sent.batch.nr + this.sent.batch.np : 0;
  }
  record(out: GPUBuffer, at: number) {
    const q = this.sent;
    if (!q || !q.batch.nr) return;
    const s = this.store!, b = q.batch, fin = s.scratch("fireinput", b.words.length), acc = s.scratch("fireacc", b.np);
    s.g.device.queue.writeBuffer(fin, 0, b.words);
    s.run(this.srcRecv, [fin, acc, out], cover(s.g, b.nr, 64), [at, b.nr, b.looks, b.tick, b.seed, b.offB, b.offR, b.offP]);
  }
  land(o: Uint32Array, at: number) {
    const q = this.sent;
    if (!q) return;
    this.sent = null;
    q.done(o.slice(at, at + q.batch.nr + q.batch.np));
  }
}
