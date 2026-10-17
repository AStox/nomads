// The fire on the GPU: the beds burning (law: wgsl/beds.ts) and what lies near them taking their heat and their brands
// (law: wgsl/fire.ts); plan docs/plans/2026-10-14-001-refactor-gpu-object-world-plan.md, Unit 12;
// docs/research/fire-constants.md secs. 36 and 37.
// Every bed the world has burning holds a slot of the beds' state on the GPU. Each run of the fire lane
// src/sim/ecology.ts fire notes the air at each bed for the look; at a landing it packs every bed (its state only where
// the GPU doesn't hold it as the CPU has it: a bed new, fed or kindled since), the air at each of its looks, and every
// fuel object within reach of one (src/sim/spread.ts receiverWords) into a piece of work that goes to the GPU with the
// landing. There each bed burns its looks and writes its blaze at each, and the receivers take those blazes' heat and
// brands; each bed's state, the look it went out at and how far it reached, the blazes and the receivers' heat and
// lighting come back with the landing, and the CPU takes each bed's state as the bed it reads (what its flame stands,
// what heat it gives, what coals it holds) until the next, and makes each thing that lit a bed of its own.
// The twins are the laws' TypeScript oracles, word for word: receive the receivers', and burnBeds the beds' (by
// src/sim/combustion.ts burnFor and spread.ts blazing and blazeWords, the same laws a world not resident on the GPU
// burns its beds by).
import { cover, pipelineSoon } from "./kernel";
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

// ---------- a landing's work ----------
// A bed's part in a landing's work: its slot, the bed as the CPU has it, whether the CPU changed it since the GPU last
// had it, and the air at each of the work's looks (null for a look it doesn't take: one before it was lit).
export type BedJob = { slot: number; bed: Bed; fresh: boolean; airs: (Uint32Array | null)[] };
// A landing's work: so many looks, the beds, and the receivers' batch, whose blazes the beds write (looks of one blaze
// for each bed, in the beds' order).
export type Work = { looks: number; beds: BedJob[]; batch: Batch };
// What comes back: each bed as it stands after its looks, the look it went out at (0 for none, else one more than the
// look), the farthest its heat and its brands reached (cm); every blaze (BW words each, look by look); and the
// receivers' words (receive's).
export type Landed = { beds: { bed: Bed; gone: number; reach: number; far: number }[]; blazes: Uint32Array; receivers: Uint32Array };
// A blaze's words where a bed doesn't blaze at a look.
export const NO_BLAZE: readonly number[] = Array.from({ length: BW }, (_, f) => (f === B.x ? NOWHERE : 0));

// The beds' twin: each bed through its looks as wgsl/beds.ts takes it, then the receivers' twin on the blazes.
export function burnBeds(work: Work): Landed {
  const { looks, beds, batch } = work, nb = beds.length, blazes = new Uint32Array(looks * nb * BW);
  const out = beds.map((job, j) => {
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
  const words = batch.words.slice();
  words.set(blazes, batch.offB);
  return { beds: out, blazes, receivers: receive({ ...batch, words }) };
}
const STEP_S = T(LOOK_S);

// ---------- the GPU ----------
// The fire riding a world's store: work queued on a landing tick goes to the GPU with that landing, and what comes back
// is handed to the work's done. The beds' state stays on the GPU between landings, a slot a bed (slotOf, keep); a bed's
// state goes up only where the GPU doesn't hold it as the CPU has it. Work still queued when the next is (a caller
// stepping fire without landing the store between) is worked out by the twins first, which give the same words, and its
// beds go up again with the next.
// The beds' kernel is the largest the world has (its first compile takes Chrome 38 s and Bun's Dawn 24 s on the AMD
// adapter, fire-constants sec. 37), so it isn't made ahead with the rest: it is set compiling (pipelineSoon) the first
// landing that has a bed, and until it is made each landing's work is worked out by the twins, which give the same words,
// and handed back as the landing lands. Whichever does the work, a world runs the same.
type Queued = { work: Work; done: (got: Landed) => void };
export class Fire implements Rider {
  store: Store | null = null;
  private srcBeds = "";
  private srcRecv = "";
  private queued: Queued | null = null;
  private sent: Queued | null = null;
  private twinned: Queued | null = null;
  private made = false;
  private state: GPUBuffer | null = null;
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
  kernelSources(): string[] { return [this.srcRecv]; }
  // Whether the beds' kernel is made, set compiling if it isn't yet.
  private bedsMade(): boolean {
    if (!this.made) {
      const p = pipelineSoon(this.store!.g, this.srcBeds);
      if (p instanceof Promise) void p.then(() => { this.made = true; });
      else this.made = true;
    }
    return this.made;
  }
  // The beds' kernel made, for a caller that wants the beds on the GPU from its first landing (a test).
  async ready() {
    await pipelineSoon(this.store!.g, this.srcBeds);
    this.made = true;
  }
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
  queue(work: Work, done: (got: Landed) => void) {
    const was = this.queued;
    this.queued = { work, done };
    if (!was) return;
    for (const b of was.work.beds) this.held.delete(b.slot);
    was.done(burnBeds(was.work));
  }

  // ---------- riding the store ----------
  words(): number {
    this.sent = this.queued;
    this.queued = null;
    if (!this.sent) return 0;
    const { looks, beds, batch } = this.sent.work;
    if (beds.length && !this.bedsMade()) { this.twinned = this.sent; this.sent = null; return 0; }
    return beds.length * (SW + BEDW + looks * BW) + batch.nr + batch.np;
  }
  record(out: GPUBuffer, at: number) {
    const q = this.sent;
    if (!q) return;
    const s = this.store!, g = s.g, { looks, beds, batch } = q.work, nb = beds.length, fin = s.scratch("fireinput", batch.words.length);
    g.device.queue.writeBuffer(fin, 0, batch.words);
    if (nb) {
      const slots = Math.max(64, ...beds.map((b) => b.slot + 1)), state = s.scratch("firebeds", slots * BEDW);
      // a state buffer made again holds nothing yet
      if (state !== this.state) { this.state = state; this.held.clear(); }
      for (const b of beds) {
        if (!b.fresh && this.held.has(b.slot)) continue;
        const phys: Phys[] = [];
        g.device.queue.writeBuffer(state, b.slot * BEDW * 4, bedWords(b.bed, phys));
        this.phys.set(b.slot, phys);
      }
      const job = new Uint32Array(nb + looks * nb * AW);
      beds.forEach((b, j) => {
        job[j] = b.slot;
        for (let k = 0; k < looks; k++) { const a = b.airs[k]; if (a) job.set(a, nb + (k * nb + j) * AW); }
      });
      const jb = s.scratch("firejob", job.length);
      g.device.queue.writeBuffer(jb, 0, job);
      s.run(this.srcBeds, [state, jb, fin, out], cover(g, nb, 64), [at, nb, looks, batch.offB, nb, 32, 0, 0]);
    }
    if (batch.nr) {
      const acc = s.scratch("fireacc", batch.np);
      s.run(this.srcRecv, [fin, acc, out], cover(g, batch.nr, 64), [at + nb * (SW + BEDW + looks * BW), batch.nr, batch.looks, batch.tick, batch.seed, batch.offB, batch.offR, batch.offP]);
    }
  }
  land(o: Uint32Array, at: number) {
    const t = this.twinned;
    if (t) {
      this.twinned = null;
      for (const b of t.work.beds) this.held.delete(b.slot);
      t.done(burnBeds(t.work));
      return;
    }
    const q = this.sent;
    if (!q) return;
    this.sent = null;
    const { looks, beds, batch } = q.work, nb = beds.length, ob = at + nb * (SW + BEDW);
    const got: Landed = {
      beds: beds.map((b, j) => {
        const s = at + j * SW, w = o.subarray(at + nb * SW + j * BEDW, at + nb * SW + (j + 1) * BEDW);
        this.held.add(b.slot);
        return { bed: bedFrom(w, this.phys.get(b.slot)!), gone: o[s + SF.gone], reach: o[s + SF.reach], far: o[s + SF.far] };
      }),
      blazes: o.slice(ob, ob + looks * nb * BW),
      receivers: o.slice(ob + looks * nb * BW, ob + looks * nb * BW + batch.nr + batch.np),
    };
    q.done(got);
  }
}
