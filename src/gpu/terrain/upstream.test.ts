// The upstream kernels (wgsl/terrain-upstream.ts): the crust, its erosion, the ice's scour and till, and the hollows, from
// the first draws of seeds 1 to 3 as the generator makes them. The kernels are the one implementation of the stage, so the
// test asks what any correct run must show, and pins what this one does:
// 1. the arithmetic: the simplex noise against math/noise's own sample, and the sine and cosine against Math's;
// 2. the crust: the Philox draws are the TypeScript twin's words, the basement holds Bornholm's share of the land, the rock
//    is the stack's layer the basement's depth reaches, the uplift's share follows the depth, the chamfer distances are
//    the exact shortest paths of their weights, the sea floor is the measured profile of the distance from the shore,
//    the dykes lie along their lines and the joint valleys are the layout the draws give;
// 2b. the erosion: no summit stands above what the stream power law's steady state allows (its calibrated chi) and every
//    flood settled within its first guess of rounds;
// 3. the ice and the ground it leaves: scour only cuts the basement, no deeper than the deepest valley, meltwater sand lies
//    where it cut and the till's classes follow its depth;
// 4. the flood and what is walked by it, on the finished ground exactly in the integers the kernel holds: the flooded
//    surface is the fixed point f = max(h, least neighbour f + eps) with the edge held, every cell's receiver is its
//    steepest descent, depth follows the receivers, the drainage area sums every cell once at the roots; the order lists
//    each cell after its receiver; and the hollows, basins and open water are what four-connected components of the
//    raised cells give;
// 5. watching changes nothing, and the same words on a second run;
// 6. a golden hash of every output (see GOLDEN).
// One case a seed (an island takes under a second).
import { afterAll, expect, test } from "bun:test";
import { simplex2d } from "math/noise";
import { rng } from "../../sim/world";
import { CELL, LEN, N } from "../../terrain/grid";
import { BARE, DOLERITE, GRANITE, MELTWATER, ROCKS, SANDSTONE, TILL_CLAY, TILL_MAX, TILL_SAND, crystalline } from "../../terrain/geology";
import { CRYSTALLINE, DYKES, DYKE_LEN, JOINT_GAP, JOINTS, JOINT_REACH, OFF_GRANITE, OFF_SEDIMENT, SCOUR, SHORE, STACK, STACK_TOP, U0, VALLEY_GAP, VALLEY_LEN, WATER_TABLE, type Stage } from "../../terrain/island";
import { releaseGpu, theGpu } from "../device";
import { philox } from "../rand";
import { DRN, EPS_ISLAND, VT, ZS } from "../wgsl/terrain-upstream";
import { noiseGpu, planFrom, treeGpu, trigGpu, upstreamRaw, type Raw } from "./upstream";

afterAll(releaseGpu);

// The hash (Bun.hash, hex) of every Upstream field's bytes in the order OUTPUTS gives them, per island. It pins the
// kernels' integer arithmetic bit for bit, so any change to the crust, the erosion, the ice or the hollows, or to their
// constants, moves it. When the model changes on purpose, re-record these from the failure message, and say in the commit
// message why they moved.
const GOLDEN: Record<number, string> = { 1: "90b0fe0ea528d375", 2: "c3f20b36f231bf4b", 3: "ed09fd481fb38b49" };

const FIELDS = ["land", "rock", "height", "drift", "driftDepth", "filled", "order", "to", "basin", "hollow", "open"] as const;
const bytes = (f: ArrayBufferView) => Buffer.from(f.buffer, f.byteOffset, f.byteLength);
const digest = (up: Raw["up"]) => Bun.hash(Buffer.concat(FIELDS.map((k) => bytes(up[k])))).toString(16);
const KEEP = ["dep", "lift", "sea", "sh", "sh2", "dr", "misc", "fl", "h", "hol", "basin", "open", "to", "lvl", "dpth"];

const NEIGHBOURS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]] as const;
const ORTH = 65536, DIAG = Math.round(Math.SQRT2 * 65536);

// the stack's layer a basement depth (Z) reaches into
function rockOf(d: number) {
  if (d <= 0) return GRANITE;
  let top = 0;
  for (const [r, m] of STACK) if (d <= (top += m) * ZS) return r;
  return SANDSTONE;
}

// the cells of the CPU's straight lines of cells, from the draws as the kernel is given them: the dykes
function dykeCells(draws: Int32Array, count: number) {
  const cells = new Set<number>();
  for (let k = 0; k < count; k++) {
    const x = (draws[3 * k] >>> 0) / 2 ** 32 * N * CELL, y = (draws[3 * k + 1] >>> 0) / 2 ** 32 * N * CELL;
    const az = (10 + 20 * ((draws[3 * k + 2] >>> 0) / 2 ** 32)) * (Math.PI / 180);
    for (let s = 0; s <= DYKE_LEN; s += CELL / 2) {
      const cx = Math.floor((x + Math.sin(az) * s) / CELL), cy = Math.floor((y - Math.cos(az) * s) / CELL);
      if (cx >= 0 && cy >= 0 && cx < N && cy < N) cells.add(cy * N + cx);
    }
  }
  return cells;
}

// the joint valleys as the CPU's loops lay them from the same draws: where each starts (m), how long and how deep
function valleysOf(draws: Int32Array, from: number) {
  const out: { x: number; y: number; len: number; deep: number }[] = [];
  let n = from;
  const next = () => (draws[n++] >>> 0) / 2 ** 32;
  for (const az of JOINTS) {
    const dx = Math.sin(az), dy = -Math.cos(az), reach = N * CELL * JOINT_REACH, mid = (N * CELL) / 2;
    for (let o = -reach; o < reach; o += JOINT_GAP * (0.5 + next())) {
      const bx = mid + Math.cos(az) * o, by = mid + Math.sin(az) * o;
      for (let s = -reach; s < reach; ) {
        const len = VALLEY_LEN[0] + VALLEY_LEN[1] * next(), deep = SCOUR * next();
        out.push({ x: bx + dx * s, y: by + dy * s, len, deep });
        s += len + VALLEY_GAP[0] + VALLEY_GAP[1] * next();
      }
    }
  }
  return out;
}

// the four-connected components of the cells the flood raised by over a centimetre, labelled by their least cell, and which
// of them are deeper than the water table
function hollowsOf(fl: Int32Array, h: Int32Array) {
  const cond = (i: number) => fl[i] >= 0 && fl[i] - h[i] >= Math.ceil(0.01 * ZS);
  const hol = new Int32Array(LEN).fill(-1), basin = new Uint8Array(LEN);
  for (let s0 = 0; s0 < LEN; s0++) {
    if (hol[s0] >= 0 || !cond(s0)) continue;
    const cells = [s0];
    let deepest = 0;
    hol[s0] = s0;
    for (let k = 0; k < cells.length; k++) {
      const i = cells[k], x = i % N, y = (i - x) / N;
      deepest = Math.max(deepest, fl[i] - h[i]);
      for (const j of [x > 0 ? i - 1 : -1, x < N - 1 ? i + 1 : -1, y > 0 ? i - N : -1, y < N - 1 ? i + N : -1]) if (j >= 0 && hol[j] < 0 && cond(j)) { hol[j] = s0; cells.push(j); }
    }
    if (deepest > WATER_TABLE * ZS) for (const i of cells) basin[i] = 1;
  }
  return { hol, basin };
}

test("the kernels' simplex noise is math/noise's within 3e-7, and their sine and cosine are Math's within 2e-9", async () => {
  const g = await theGpu();
  let s = 99;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
  const gen = simplex2d.create(12345);
  // the coordinates the crust asks for reach about 33, and the kernel reads them in Q24
  const xs = Array.from({ length: 6000 }, () => Math.round((rnd() * 66 - 33) * 2 ** 24) / 2 ** 24);
  const ys = Array.from({ length: 6000 }, () => Math.round((rnd() * 66 - 33) * 2 ** 24) / 2 ** 24);
  const noise = await noiseGpu(g, gen.perm, xs, ys);
  let worst = 0;
  for (let i = 0; i < xs.length; i++) worst = Math.max(worst, Math.abs(noise[i] - simplex2d.sample(gen, xs[i], ys[i])));
  expect(worst).toBeLessThan(3e-7);
  const fractions = Array.from({ length: 5000 }, () => rnd());
  const trig = await trigGpu(g, fractions);
  let off = 0;
  fractions.forEach((a, i) => { off = Math.max(off, Math.abs(trig[i][0] - Math.sin(Math.PI * a)), Math.abs(trig[i][1] - Math.cos(Math.PI * a))); });
  expect(off).toBeLessThan(2e-9);
});

test.each([1, 2, 3])("upstream seed %i", async (seed) => {
  const g = await theGpu();
  const plan = planFrom(rng(seed));
  const t0 = performance.now();
  const raw = await upstreamRaw(g, plan, undefined, KEEP);
  const ms = performance.now() - t0;
  const { up, fields: f } = raw;
  console.log(`seed ${seed}: ${ms.toFixed(0)} ms, ${raw.rounds} rounds, response time ${raw.tau.toExponential(3)} yr`);
  expect(raw.flags, "flags raised").toBe(0);
  // every flood settled within its first guess of rounds
  expect(raw.rounds).toBe(192);

  // ---- the crust ----
  const draws = f.dr, nd = raw.misc[3];
  for (let n = 0; n < 12; n++) expect(draws[n] >>> 0, `draw ${n} is the Philox twin's`).toBe(philox([n, 0x55505354, 0, 0], plan.key)[0]);
  let nland = 0, basement = 0;
  for (let i = 0; i < LEN; i++) if (up.land[i]) { nland++; if (f.dep[i] <= 0) basement++; }
  // the hinge puts Bornholm's share of the land on the basement, to within the cells that tie at the hinge
  expect(Math.abs(basement / nland - CRYSTALLINE)).toBeLessThan(3 / nland);
  // the CPU's Math.round(DYKES * basement * CELL * CELL)
  expect(nd).toBe(Math.round(DYKES * basement * CELL * CELL));
  const dykes = dykeCells(draws, nd);
  let missing = 0, extra = 0, dolerite = 0;
  for (let i = 0; i < LEN; i++) {
    const oracle = rockOf(f.dep[i]);
    // the rock is the layer the depth reaches, and the dykes turn some of the basement to dolerite
    if (up.rock[i] !== oracle && !(oracle === GRANITE && up.rock[i] === DOLERITE)) throw new Error(`rock ${up.rock[i]} at cell ${i}, depth ${f.dep[i] / ZS}`);
    const want = oracle === GRANITE && dykes.has(i);
    if (up.rock[i] === DOLERITE) { dolerite++; if (!want) extra++; } else if (want) missing++;
    const lift = up.land[i] ? 1 - 0.5 * Math.min(1, Math.max(0, f.dep[i] / ZS / STACK_TOP)) : 0;
    if (Math.abs(f.lift[i] / 2 ** 24 - lift) > 1e-6) throw new Error(`lift at cell ${i}`);
  }
  expect(dolerite).toBeGreaterThan(0);
  // the cells a line crosses within a rounding of a cell's edge may fall either side
  expect(missing + extra).toBeLessThan(6);
  // the two chamfers are shortest paths of their weights: nothing is farther than a neighbour's distance and a step
  for (const [dist, mark] of [[f.sh, (i: number) => up.land[i] === 1], [f.sh2, (i: number) => up.land[i] === 0]] as const) {
    for (let i = 0; i < LEN; i++) {
      const x = i % N, y = (i - x) / N;
      if (mark(i)) expect(dist[i]).toBe(0);
      for (const [dx, dy] of NEIGHBOURS) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
        if (dist[i] > (dist[ny * N + nx] >>> 0) + (dx && dy ? DIAG : ORTH)) throw new Error(`distance at cell ${i}`);
      }
    }
  }
  // the sea floor is Bornholm's profile of the distance from the shore, in the rock's class, and the land's is unset
  for (let i = 0; i < LEN; i++) {
    if (up.land[i]) { expect(f.sea[i]).toBe(0); continue; }
    const prof = crystalline(up.rock[i]) ? OFF_GRANITE : OFF_SEDIMENT, shore = ((f.sh[i] >>> 0) / 65536) * CELL;
    let k = 1;
    while (k < SHORE.length - 1 && SHORE[k] < shore) k++;
    const want = -(prof[k - 1] + (prof[k] - prof[k - 1]) * Math.min(1, Math.max(0, (shore - SHORE[k - 1]) / (SHORE[k] - SHORE[k - 1]))));
    if (Math.abs(f.sea[i] / ZS - want) > 2e-4) throw new Error(`sea floor at cell ${i}: ${f.sea[i] / ZS} against ${want}`);
  }
  // the valleys are the layout the draws give
  const lines = valleysOf(draws, 3 * nd), nv = raw.misc[2];
  expect(nv).toBe(lines.length);
  lines.forEach((v, k) => {
    const o = VT + 8 * k;
    expect(Math.abs(f.misc[o] / 2 ** 15 - v.x)).toBeLessThan(1e-3);
    expect(Math.abs(f.misc[o + 1] / 2 ** 15 - v.y)).toBeLessThan(1e-3);
    expect(Math.abs(f.misc[o + 2] / 2 ** 15 - v.len)).toBeLessThan(1e-3);
    expect(Math.abs(f.misc[o + 3] / ZS - v.deep)).toBeLessThan(1e-4);
  });
  expect(3 * nd + 3 * nv + 2 * 40).toBeLessThan(DRN);

  // ---- the erosion ----
  // the highest summit stands (U / K) chi above the sea, chi near 12.2 (island.ts U0, the calibration)
  let summit = 0;
  for (let i = 0; i < LEN; i++) if (up.land[i]) summit = Math.max(summit, up.height[i]);
  const chi = summit / (U0 / ROCKS[GRANITE].erode);
  expect(chi).toBeGreaterThan(9);
  expect(chi).toBeLessThan(15);

  // ---- the ice and its till ----
  const scour = raw.scour;
  let scoured = 0;
  for (let i = 0; i < LEN; i++) {
    if (scour[i] > 0) {
      scoured++;
      // only the basement is cut, no deeper than the deepest valley, and meltwater sand fills it to the till's greatest
      expect(up.land[i] === 1 && crystalline(up.rock[i])).toBe(true);
      expect(scour[i]).toBeLessThanOrEqual(SCOUR * ZS);
      expect(up.drift[i]).toBe(MELTWATER);
      expect(up.driftDepth[i]).toBe(TILL_MAX);
    } else if (!up.land[i]) {
      expect([up.drift[i], up.driftDepth[i]]).toEqual([0, 0]);
    } else if (crystalline(up.rock[i])) {
      expect(up.drift[i]).toBe(up.driftDepth[i] > 0 ? TILL_SAND : BARE);
      expect(up.driftDepth[i]).toBeLessThanOrEqual(TILL_MAX);
    } else {
      expect([up.drift[i], up.driftDepth[i]]).toEqual([TILL_CLAY, TILL_MAX]);
    }
  }
  expect(scoured).toBeGreaterThan(0);

  // ---- the flood and what is walked by it, exact in the kernel's integers ----
  const hz = Int32Array.from(up.height, (v) => Math.round(v * ZS));
  const tree = await treeGpu(g, up.height);
  expect(tree.flags).toBe(0);
  const { filled, to, area, depth } = tree;
  for (let i = 0; i < LEN; i++) {
    const x = i % N, y = (i - x) / N;
    let least = 0x7fffffff, bestKey = 0n, bestTo = i;
    for (let d = 0; d < 8; d++) {
      const nx = x + NEIGHBOURS[d][0], ny = y + NEIGHBOURS[d][1];
      if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
      const j = ny * N + nx;
      least = Math.min(least, filled[j]);
      const dz = filled[i] - filled[j];
      const key = dz > 0 ? BigInt(dz) * (d % 2 ? 1518500250n : 2147483648n) : 0n;
      if (filled[i] >= 0 && key > bestKey) { bestKey = key; bestTo = j; }
    }
    if (x === 0 || y === 0 || x === N - 1 || y === N - 1) expect(filled[i]).toBe(hz[i]);
    else if (filled[i] !== Math.max(hz[i], least + EPS_ISLAND)) throw new Error(`flooded surface at cell ${i}`);
    expect(filled[i]).toBeGreaterThanOrEqual(hz[i]);
    if (to[i] !== bestTo) throw new Error(`receiver of cell ${i}`);
  }
  // depth follows the receivers, and the drainage area is a cell and what drains into it
  const sum = new Int32Array(LEN).fill(1);
  for (let i = 0; i < LEN; i++) {
    expect(depth[i]).toBe(to[i] === i ? 0 : depth[to[i]] + 1);
    if (to[i] !== i) sum[to[i]] += area[i];
  }
  let total = 0;
  for (let i = 0; i < LEN; i++) { expect(area[i]).toBe(sum[i]); if (to[i] === i) total += area[i]; }
  expect(total).toBe(LEN);
  // the order lists every cell once, each after its receiver, by depth along the receivers and then by index
  const place = new Int32Array(LEN).fill(-1);
  up.order.forEach((c, p) => { place[c] = p; });
  for (let i = 0; i < LEN; i++) expect(place[i]).toBeGreaterThanOrEqual(0);
  for (let p = 1; p < LEN; p++) {
    const a = up.order[p - 1], b = up.order[p];
    if (depth[a] > depth[b] || (depth[a] === depth[b] && a > b)) throw new Error(`order at ${p}`);
  }
  // the hollows, the basins and the open water of the kernel's own flood
  const { hol, basin } = hollowsOf(f.fl, f.h);
  for (let i = 0; i < LEN; i++) {
    if (f.hol[i] !== hol[i] || f.basin[i] !== basin[i]) throw new Error(`hollow at cell ${i}`);
    expect(up.open[i]).toBe(f.fl[i] < 0 || basin[i] ? 1 : 0);
  }
  expect(basin.some((b) => b === 1)).toBe(true);

  // ---- the same words again, with a watcher, and a pinned hash ----
  const stages: Stage["stage"][] = [];
  let steps = 0;
  const again = await upstreamRaw(g, planFrom(rng(seed)), (s) => { stages.push(s.stage); if (s.stage === "erode") { expect(s.step).toBe(steps++); expect(s.steps).toBe(60); } });
  expect([stages[0], stages[stages.length - 1], steps]).toEqual(["rock", "ice", 60]);
  for (const k of FIELDS) expect(Buffer.compare(bytes(again.up[k]), bytes(up[k])), `${k} on a second run, watched`).toBe(0);
  expect([again.tau, again.flags]).toEqual([raw.tau, raw.flags]);
  const hash = digest(up);
  if (GOLDEN[seed] === "") console.log(`seed ${seed} golden: ${hash}`);
  expect(hash, `seed ${seed} golden, re-record deliberately`).toBe(GOLDEN[seed]);
}, 280_000);
