// A geometric multigrid for the water table's relaxation (Unit 5b): the plain colour sweeps of aquifer.ts move a plateau's slowest mode by an e-fold in thousands of sweeps (real tier 3: 20,800 sweeps
// and the table still moving metres). The schedule of what is run here is fixed (sweeps per tier, cycles), so the heads are a pure function of the coefficients and the schedule: the same under any
// tiling. [gap] The cycles below do not converge on the real tier 3 (the greatest residual within 8 m of the ground stalls at 4e5 to 5e5 units, 3 to 4 m, with the cycles' own coarse correction
// raising it again from a state at 800); a linear problem on the same conductances stalls at a factor of 0.9 a cycle at one place where the sea's cells are scattered among land, and a uniform one
// converges at 0.54 a cycle. What does work, and is measured, is `start`: each tier solved by the over-relaxed sweeps from the tier above's heads (the full multigrid's cascade).
//
// Every tier is the island's own step (aq_cell_n, the one law) on coefficients made from the finer tier's, so the coarse tiers carry the ground's cap, the plants' draw and the sea as the fine one
// does, and a full-approximation cycle is right where the problem is not linear (the table is capped by the ground, and the draw is a function of its depth):
//   faces: half the sum of the two fine faces on a coarse cell's side (the doubled cell has the fine cell's conductance: 2 faces in parallel over twice the length);
//   draw: the fine cells' steepest slopes (evk) summed (a leak goes with the area), the draw itself a flux that is the sum of theirs (eaf is the sum of S eaf over the coarse total);
//   source: the fine fluxes summed over the coarse total; the season's pet and unmet demand, the ground and the depth's parameters: the mean of the children's;
//   fixed: a coarse cell with a sea child is fixed (at the restricted head, so its correction is 0).
// A cycle: smooth, restrict the heads (mean of the 4 children) and the residual (the fluxes S d summed, over the coarse total), and have the coarse tier solve its own step with the source moved by
// what the residual and the coarse step on the restricted heads differ by (FAS: the coarse fixed point is the restricted state when the fine residual is 0), then take the coarse tier's change in
// head up by the bilinear children of regional.ts's stencil and add it under the cap.
import type { Gpu } from "../device";
import { GlobalAquifer } from "./aquifer";
import { FACES, tierGrid } from "./grid";
import { around3, child4, CORNER_BESIDE } from "./regional";

// The bilinear children of a tier's field (a child at 1/4 or 3/4 of the way to the neighbours on each axis, regional's stencil; at a face's edge or corner the neighbours are the ones across the
// edge), each rounded to the unit: no constant is added to a block, so a smooth field stays smooth where its blocks meet.
function prolong(tier: number, from: Int32Array): Int32Array {
  const fnp = tierGrid(tier).fn, fn = fnp * 2, cells = fnp * fnp, g = tierGrid(tier), ids = new Int32Array(9), val = new Float64Array(9), q = new Float64Array(4), out = new Int32Array(4 * from.length);
  for (let f = 0; f < FACES; f++)
    for (let Y = 0; Y < fnp; Y++)
      for (let X = 0; X < fnp; X++) {
        const p = f * cells + Y * fnp + X;
        if (X > 0 && X < fnp - 1 && Y > 0 && Y < fnp - 1) child4(from[p], from[p - 1], from[p + 1], from[p - fnp], from[p + fnp], from[p - fnp - 1], from[p - fnp + 1], from[p + fnp - 1], from[p + fnp + 1], q);
        else {
          around3(g, f, X, Y, ids);
          for (let c = 0; c < 9; c++) if (ids[c] >= 0) val[c] = from[ids[c]];
          for (const [c, a, b] of CORNER_BESIDE) if (ids[c] < 0) val[c] = (val[a] + val[b]) / 2;
          child4(val[4], val[3], val[5], val[1], val[7], val[0], val[2], val[6], val[8], q);
        }
        const o = (f * fn + 2 * Y) * fn + 2 * X;
        out[o] = Math.round(q[0]); out[o + 1] = Math.round(q[1]); out[o + fn] = Math.round(q[2]); out[o + fn + 1] = Math.round(q[3]);
      }
  return out;
}

// The transpose of prolong's stencil (full weighting): each fine value goes to the coarse cell it is a child of with 9/16, to the two beside it with 3/16 and to the corner one with 1/16, the
// missing corner cell of a face's corner taking its half from each of the two beside it, as prolong does. The weights of a coarse cell sum to 4.
const QUAD = [[4, 3, 1, 0], [4, 5, 1, 2], [4, 3, 7, 6], [4, 5, 7, 8]] as const; // per child (SW, SE, NW, NE): the centre, the side on x, the side on y, the corner (indices of the 3 by 3)
function restrictT(tier: number, fine: Float64Array): Float64Array {
  const fnp = tierGrid(tier).fn, fn = fnp * 2, cells = fnp * fnp, g = tierGrid(tier), ids = new Int32Array(9), out = new Float64Array(FACES * cells);
  const add = (k: number, v: number) => { out[ids[k]] += v; };
  for (let f = 0; f < FACES; f++)
    for (let Y = 0; Y < fnp; Y++)
      for (let X = 0; X < fnp; X++) {
        const p = f * cells + Y * fnp + X, o = (f * fn + 2 * Y) * fn + 2 * X, v = [fine[o], fine[o + 1], fine[o + fn], fine[o + fn + 1]];
        if (X > 0 && X < fnp - 1 && Y > 0 && Y < fnp - 1) {
          ids[0] = p - fnp - 1; ids[1] = p - fnp; ids[2] = p - fnp + 1; ids[3] = p - 1; ids[4] = p; ids[5] = p + 1; ids[6] = p + fnp - 1; ids[7] = p + fnp; ids[8] = p + fnp + 1;
          for (let q = 0; q < 4; q++) { const [c, a, b, k] = QUAD[q], x = v[q] / 16; add(c, 9 * x); add(a, 3 * x); add(b, 3 * x); add(k, x); }
        } else {
          around3(g, f, X, Y, ids);
          for (let q = 0; q < 4; q++) {
            const [c, a, b, k] = QUAD[q], x = v[q] / 16;
            add(c, 9 * x); add(a, 3 * x); add(b, 3 * x);
            if (ids[k] >= 0) add(k, x);
            else { const [, s1, s2] = CORNER_BESIDE.find(([corner]) => corner === k) as readonly [number, number, number]; add(s1, x / 2); add(s2, x / 2); }
          }
        }
      }
  return out;
}
const E = 0, N = 1, W = 2, S = 3; // +x, +y, -x, -y in the face's own axes
const U = 2 ** 31;
const HOST = ["head", "ww", "we", "wn", "ws", "meta", "eaf", "sso", "ht", "fxv", "pe01", "pe23", "sh01", "sh23"] as const;
// A tier's static state on the host: its packed planes, the conductance of each cell's four faces, the draw's steepest slope evk and the total S the weights are over (faces and evk)
interface Level { tier: number; n: number; planes: Record<string, Int32Array>; c: Float64Array[]; S: Float64Array; evk: Float64Array }

function fineLevel(tier: number, load: (plane: string) => Int32Array): Level {
  const n = FACES * tierGrid(tier).fn ** 2, planes: Record<string, Int32Array> = {};
  for (const name of HOST) planes[name] = load(name);
  const sum = load("sum"), { ww, we, wn, ws, eaf } = planes, c = [new Float64Array(n), new Float64Array(n), new Float64Array(n), new Float64Array(n)], s = new Float64Array(n), evk = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const tot = sum[i] >>> 0, a = we[i] >>> 0, b = ws[i] >>> 0, d = ww[i] >>> 0, e = wn[i] >>> 0;
    c[E][i] = (a * tot) / U; c[N][i] = (b * tot) / U; c[W][i] = (d * tot) / U; c[S][i] = (e * tot) / U;
    evk[i] = eaf[i] !== 0 ? (tot * (U - a - b - d - e)) / U : 0;
    s[i] = tot;
  }
  return { tier, n, planes, c, S: s, evk };
}

const half = (w: number, s: number) => (w >>> (16 * s)) & 0xffff;
// The tier above, made from this one's coefficients (the rules at the top of the file)
function coarsen(f: Level): Level {
  const fnF = tierGrid(f.tier).fn, fn = fnF / 2, n = FACES * fn * fn, fp = f.planes, planes: Record<string, Int32Array> = {};
  for (const name of HOST) planes[name] = new Int32Array(n);
  const c = [new Float64Array(n), new Float64Array(n), new Float64Array(n), new Float64Array(n)], s = new Float64Array(n), evk = new Float64Array(n), mean8 = new Float64Array(8);
  const wsrc = [fp.pe01, fp.pe01, fp.pe23, fp.pe23, fp.sh01, fp.sh01, fp.sh23, fp.sh23];
  for (let face = 0, p = 0; face < FACES; face++)
    for (let Y = 0; Y < fn; Y++)
      for (let X = 0; X < fn; X++, p++) {
        const b = (face * fnF + 2 * Y) * fnF + 2 * X, kids = [b, b + 1, b + fnF, b + fnF + 1];
        c[E][p] = (f.c[E][kids[1]] + f.c[E][kids[3]]) / 2; c[N][p] = (f.c[N][kids[2]] + f.c[N][kids[3]]) / 2; c[W][p] = (f.c[W][kids[0]] + f.c[W][kids[2]]) / 2; c[S][p] = (f.c[S][kids[0]] + f.c[S][kids[1]]) / 2;
        let ev = 0, flux = 0, draw = 0, any2 = false, ground = 0, fill = 0, filled = 0, model = -1, fxv = 0, sea = 0, seaN = 0, heads = 0;
        mean8.fill(0);
        for (const i of kids) {
          const k = fp.meta[i] & 3;
          ev += f.evk[i]; flux += f.S[i] * fp.sso[i]; draw += f.S[i] * fp.eaf[i]; ground += fp.ht[i];
          if (k === 2) any2 = true;
          fxv += k === 2 ? fp.fxv[i] : fp.ht[i] * 512;
          if (k === 1) { sea += fp.fxv[i]; seaN++; }
          heads += fp.head[i];
          if (k !== 1) { fill += fp.meta[i] >>> 10; filled++; if (model < 0 && fp.eaf[i] !== 0) model = i; }
          for (let v = 0; v < 8; v++) mean8[v] += half(wsrc[v][i], v & 1);
        }
        const isf = seaN > 0 ? 1 : any2 ? 2 : 0, ci = c[E][p] + c[N][p] + c[W][p] + c[S][p];
        evk[p] = ev; s[p] = ci + ev;
        if (model < 0) model = b;
        planes.eaf[p] = ev > 0 ? Math.max(1, Math.round(draw / s[p])) : 0;
        planes.sso[p] = s[p] > 0 ? Math.round(flux / s[p]) : 0;
        planes.ht[p] = Math.round(ground / 4);
        planes.fxv[p] = isf === 1 ? Math.round(sea / seaN) : isf === 2 ? Math.round(fxv / 4) : 0;
        planes.head[p] = isf === 1 ? planes.fxv[p] : Math.round(heads / 4);
        planes.meta[p] = isf | (((fp.meta[model] >>> 2) & 7) << 2) | (((fp.meta[model] >>> 5) & 7) << 5) | ((filled ? Math.round(fill / filled) : 0) << 10);
        const m = (v: number) => Math.round(mean8[v] / 4);
        planes.pe01[p] = m(0) | (m(1) << 16); planes.pe23[p] = m(2) | (m(3) << 16); planes.sh01[p] = m(4) | (m(5) << 16); planes.sh23[p] = m(6) | (m(7) << 16);
        if (s[p] > 0) {
          planes.we[p] = Math.floor((c[E][p] / s[p]) * U); planes.ws[p] = Math.floor((c[N][p] / s[p]) * U); planes.ww[p] = Math.floor((c[W][p] / s[p]) * U); planes.wn[p] = Math.floor((c[S][p] / s[p]) * U);
        }
      }
  return { tier: f.tier - 1, n, planes, c, S: s, evk };
}

export interface MgSchedule { pre: number; post: number; coarsest: number; coarsestOmega: number; smootherOmega?: number }
export const SCHEDULE: MgSchedule = { pre: 2, post: 2, coarsest: 4000, coarsestOmega: 1.9 };
export interface CycleReport { cycle: number; shallow: number; all: number; seconds: number }

export class Multigrid {
  private constructor(private readonly levels: { level: Level; aq: GlobalAquifer }[], private readonly sched: MgSchedule) {}
  // `load` gives the finest tier's planes (those of GlobalAquifer, and "sum": each cell's total conductance); the coarse tiers down to tier 0 are made from them.
  static build(gpu: Gpu, tier: number, load: (plane: string) => Int32Array, sched = SCHEDULE): Multigrid {
    const levels: { level: Level; aq: GlobalAquifer }[] = [];
    let level = fineLevel(tier, load);
    levels.push({ level, aq: new GlobalAquifer(gpu, tier, load, false, sched.smootherOmega ?? 1) });
    while (level.tier > 0) {
      level = coarsen(level);
      const planes = level.planes;
      levels.push({ level, aq: new GlobalAquifer(gpu, level.tier, (p) => (p === "meta" || p === "head" ? planes[p].slice() : planes[p]), false, level.tier === 0 ? sched.coarsestOmega : sched.smootherOmega ?? 1) });
    }
    return new Multigrid(levels, sched);
  }
  get fine() { return this.levels[0].aq; }
  // The over-relaxation of every tier but the coarsest's (the cascade's sweeps solve, 1.99; a cycle's smooth, 1).
  setOmega(omega: number) { for (let l = 0; l < this.levels.length - 1; l++) this.levels[l].aq.omega = omega; }
  // One cycle from level l down and up; the finest tier's heads are corrected.
  private async cycle(l: number): Promise<void> {
    const { aq, level } = this.levels[l];
    if (l === this.levels.length - 1) { aq.sweeps(this.sched.coarsest); return; }
    aq.sweeps(this.sched.pre);
    await aq.residual();
    const d = await aq.plane("res"), h = await aq.head(), up = this.levels[l + 1], u = up.level, fnF = tierGrid(level.tier).fn, fn = fnF / 2;
    const flux = new Float64Array(level.n);
    for (let i = 0; i < level.n; i++) flux[i] = level.S[i] * d[i];
    const rho = restrictT(u.tier, flux), rh = new Int32Array(u.n);
    for (let face = 0, p = 0; face < FACES; face++)
      for (let Y = 0; Y < fn; Y++)
        for (let X = 0; X < fn; X++, p++) {
          const b = (face * fnF + 2 * Y) * fnF + 2 * X, b1 = b + 1, b2 = b + fnF, b3 = b + fnF + 1;
          rh[p] = Math.round((h[b] + h[b1] + h[b2] + h[b3]) / 4);
        }
    up.aq.setPlane("head", rh); up.aq.setPlane("sso", u.planes.sso);
    await up.aq.residual();
    const dc = await up.aq.plane("res"), sso = new Int32Array(u.n);
    for (let p = 0; p < u.n; p++) sso[p] = (u.planes.meta[p] & 3) === 1 || u.S[p] === 0 ? u.planes.sso[p] : u.planes.sso[p] - dc[p] + Math.round(rho[p] / u.S[p]);
    up.aq.setPlane("sso", sso);
    await this.cycle(l + 1);
    const v = await up.aq.head();
    for (let p = 0; p < u.n; p++) v[p] -= rh[p];
    aq.setPlane("res", prolong(u.tier, v));
    aq.correct();
    aq.sweeps(this.sched.post);
  }
  // The start: the coarsest tier solved, its heads carried up as the next tier's first guess (the sea's and the caps held), the tier given `cycles` cycles (or, with `sweeps`, that many sweeps of
  // its own smoother) and so up to the finest.
  async start(cycles: number, log: (s: string) => void = () => {}, sweeps?: number[]): Promise<void> {
    const last = this.levels.length - 1;
    await this.cycle(last);
    for (let l = last - 1; l >= 0; l--) {
      const { aq, level } = this.levels[l], up = this.levels[l + 1], p = level.planes, guess = prolong(up.level.tier, await up.aq.head());
      for (let i = 0; i < level.n; i++) {
        const k = p.meta[i] & 3;
        guess[i] = k === 1 ? p.fxv[i] : Math.min(k === 2 ? p.fxv[i] : p.ht[i] * 512, guess[i]);
      }
      aq.setPlane("head", guess); aq.setPlane("sso", p.sso);
      if (sweeps) aq.sweeps(sweeps[l]); else for (let c = 0; c < cycles; c++) await this.cycle(l);
      const r = await aq.residual();
      log(`start: tier ${level.tier} after ${sweeps ? `${sweeps[l]} sweeps` : `${cycles} cycles`}: shallow ${r.shallow} all ${r.all}`);
    }
  }
  // `n` cycles, each followed by the residual at the finest tier (the greatest, in the head's unit, over the cells within 8 m of the ground and over all).
  async run(n: number, log: (r: CycleReport) => void = () => {}): Promise<CycleReport[]> {
    const out: CycleReport[] = [];
    for (let i = 1; i <= n; i++) {
      const t0 = performance.now();
      await this.cycle(0);
      const r = await this.fine.residual(), rep = { cycle: i, shallow: r.shallow, all: r.all, seconds: (performance.now() - t0) / 1000 };
      out.push(rep); log(rep);
    }
    return out;
  }
  release() { for (const { aq } of this.levels) aq.release(); }
}
