// The fine tiers' erosion law on a test region (src/gpu/globe/land.ts): a square block of the 75 m planet (tier 5) or of the 150 m tier above it, of `--tiles` tier-5 tiles a side from tile
// (--tx, --ty) of a face, started from tier 3's heights carried down (the chain's own carry; tier 3's file is made by `NOMADS_BAKE=/tmp/planet-75m/land bun scripts/globe-tiers.ts --seed 1
// --key <key> --last 3`), the cells round it held (tier 5: at the bake's heights; tier 4: at the carried ones). The island's law as the fine tiers' solve: eight-neighbour routing, one rain,
// an exact smooth uplift; the step length is a schedule. Resumable (state in /tmp/planet-75m/land/<name>/); pictures and measures with --render.
//   lockf /tmp/nomads-gpu.lock bun scripts/globe-land-region.ts --name range --face 0 --tx 19 --ty 12 --tiles 12 --schedule 26x4,13x6,6.5x10,3.25x4,1.6x4 --uniform-rain --budget 230
//   lockf /tmp/nomads-gpu.lock bun scripts/globe-land-region.ts --name range --face 0 --tx 19 --ty 12 --tiles 12 --uniform-rain --render --view 1024,1024,1024 --out /tmp/planet-75m/land/view/range.png
//   --tier 4            the region at the 150 m tier (a run of its own); --from4 <name> starts a tier-5 run from a tier-4 run's state
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { releaseGpu, theGpu } from "../src/gpu/device";
import { defaultParams } from "../src/gpu/globe/erosion";
import { LAND_HALO, LandRegion, readCells, regionBlock4, regionStart, type LandState } from "../src/gpu/globe/land";
import { tierTable } from "../src/gpu/globe/regional";
import { readPlanet, type Planet } from "../src/gpu/globe/window";
import { patchAt } from "../src/gpu/globe/patch";
import { STORE } from "./globe-planet";
import { diskStore } from "./globe-window";
import { diagonalPower, measures } from "./globe-land-real";
import { blockStep, dissection, shoreHeights, lattice, renderLand, responseYears } from "./globe-land-metrics";

const arg = (name: string, d: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : d; };
const flag = (name: string) => process.argv.includes(`--${name}`);
const seed = 1, key = arg("key", "7f6ff6c82cdd");
const name = arg("name", "range"), face = Number(arg("face", "0")), tx = Number(arg("tx", "20")), ty = Number(arg("ty", "12")), tiles = Number(arg("tiles", "12")), TIER = Number(arg("tier", "5"));
const down = 2 ** (5 - TIER), size5 = tiles * 256, x05 = tx * 256, y05 = ty * 256;
const size = size5 / down, x0 = x05 / down, y0 = y05 / down, HL = 2, S = size + 2 * HL, cellM = 75 * down, per = 1 << TIER;
const bake = `/tmp/planet-75m/${seed}-${key}`, LAND = arg("land-dir", process.env.NOMADS_LAND ?? "/tmp/planet-75m/land"), work = `${LAND}/${name}`;
mkdirSync(work, { recursive: true });
const dtMy = Number(arg("dt-my", "1")), nflow = Number(arg("nflow", "8")) as 4 | 8, budget = Number(arg("budget", "200")), uniform = flag("uniform-rain");
const schedule = arg("schedule", "").split(",").filter(Boolean).map((e) => e.split("x").map(Number) as [number, number]);
const dtAt = (step: number) => { let n = 0; for (const [dt, k] of schedule) { n += k; if (step < n) return dt; } return dtMy; };
const scheduled = schedule.reduce((n, [, k]) => n + k, 0);
const t0 = performance.now(), spent = () => (performance.now() - t0) / 1000;

const meta = () => (existsSync(join(work, "meta.json")) ? JSON.parse(readFileSync(join(work, "meta.json"), "utf8")) : { steps: 0 });
const i32 = (path: string) => { const b = readFileSync(path); return new Int32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };
const readI32 = (f: string) => i32(join(work, f));
const writeI32 = (f: string, a: Int32Array) => writeFileSync(join(work, f), new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
const tableOf = (planet: Planet, dt: number) => tierTable(planet, TIER, defaultParams({ dtYr: dt * 1e6 }), uniform);

// the start of the interior (a kept state, a tier-4 run's state carried down, or tier 3's heights carried down) and the patch's ring: tier 5 from the bake's heights (held), tier 4 from the carry
function inputs() {
  const kept = existsSync(join(work, "state.i32")), t4 = regionBlock4(i32(`${arg("t3dir", LAND)}/1-7f6ff6c82cdd/t3-height.i32`), face, x05, y05, size5), fn4 = 1024 * 4;
  const from4 = arg("from4", "");
  if (from4) { const s4 = i32(`${LAND}/${from4}/state.i32`), n4 = size5 / 2; for (let y = 0; y < n4; y++) for (let x = 0; x < n4; x++) t4[(face * fn4 + y05 / 2 + y) * fn4 + x05 / 2 + x] = s4[y * n4 + x]; }
  const p = patchAt(TIER, face, x0, y0, HL, size);
  let interior: Int32Array, h: Int32Array, fl: Int32Array;
  if (TIER === 5) { interior = kept ? readI32("state.i32") : regionStart(t4, face, x05, y05, size5); h = readCells(join(bake, "t5-height.i32"), p.ids); fl = readCells(join(bake, "t5-flooded.i32"), p.ids); }
  else { h = Int32Array.from(p.ids, (id) => t4[id]); fl = Int32Array.from(h); interior = kept ? readI32("state.i32") : new Int32Array(size * size); if (!kept) for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) interior[y * size + x] = h[(y + HL) * S + x + HL]; }
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) h[(y + HL) * S + x + HL] = interior[y * size + x];
  return { h, fl, kept };
}
const interiorOf = (h: Int32Array) => { const inner = new Int32Array(size * size); for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) inner[y * size + x] = h[(y + HL) * S + x + HL]; return inner; };

const planet = await readPlanet(seed, diskStore(STORE, key)), gpu = await theGpu();
try {
  const m = meta(), { h, fl, kept } = inputs();
  console.log(`tier ${TIER} region ${size}x${size} face ${face} at ${x0},${y0}, planet and start ${spent().toFixed(1)} s, ${m.steps} steps kept`);
  const r = new LandRegion(gpu, TIER, face, x0, y0, size, tableOf(planet, schedule.length ? dtAt(m.steps) : dtMy), h, fl, { nflow, stochastic: flag("stochastic"), rho8: flag("rho8") || flag("final-rho8"), slide: flag("slide16") ? 16 : 8 });
  if (kept) r.load({ height: h, carry: readI32("carry.i32"), steps: m.steps } as LandState);

  if (flag("render")) {
    await r.flow();
    const acc = await r.solver.read("ACC"), to = await r.solver.read("TO"), height = await r.solver.read("H");
    const at = (x: number, y: number) => ((Math.min(size - 1, Math.max(0, y)) + HL) * S + Math.min(size - 1, Math.max(0, x)) + HL);
    const dump = (f: string, a: ArrayLike<number>) => { const o = new Int32Array(1 + a.length); o[0] = S; for (let k = 0; k < a.length; k++) o[k + 1] = a[k]; writeFileSync(join(work, f), new Uint8Array(o.buffer)); };
    dump("flow.bin", to); dump("acc.bin", acc);
    const v = arg("view", `0,0,${size}`).split(",").map(Number) as [number, number, number], out = arg("out", join(work, "view.png"));
    writeFileSync(out, renderLand((x, y) => height[at(x, y)] / 256, (x, y) => acc[at(x, y)] / 512, v, Number(arg("scale", "2")), Number(arg("river", "100")), Number(arg("vex", "0")), cellM));
    // measures over the interior's land, from a margin of 64 cells in (the held ring's reach)
    const live = new Uint8Array(S * S), margin = Math.floor(64 / down);
    for (let y = margin; y < size - margin; y++) for (let x = margin; x < size - margin; x++) live[(y + HL) * S + x + HL] = height[(y + HL) * S + x + HL] > 0 ? 1 : 0;
    const cells = new Float64Array(S * S);
    for (let k = 0; k < cells.length; k++) cells[k] = acc[k] / 512;
    const res: Record<string, unknown> = { tier: TIER, steps: m.steps, nflow, lattice30: lattice(to, cells, S, live, 30, 8), lattice300: lattice(to, cells, S, live, 300, 8), tauMy: +(responseYears(to, cells, S, live, 7.07e-8, cellM) / 1e6).toFixed(0) };
    // each tier-0 cell's mean height in the region (all its children) against the planet's: the means the lift holds
    const err: number[] = [];
    for (let py = 0; py < size / per; py++) for (let px = 0; px < size / per; px++) {
      let sum = 0, land = 0;
      for (let y = 0; y < per; y++) for (let x = 0; x < per; x++) { const v = height[((py * per + y) + HL) * S + px * per + x + HL]; sum += v; if (v > 0) land++; }
      if (land) err.push(Math.abs(sum / (per * per) / 256 - planet.height[(face * 256 + y0 / per + py) * 256 + x0 / per + px]));
    }
    err.sort((a, b) => a - b);
    res.meanErrM = { parents: err.length, p50: +err[Math.floor(err.length * 0.5)].toFixed(2), p90: +err[Math.floor(err.length * 0.9)].toFixed(2), p99: +err[Math.floor(err.length * 0.99)].toFixed(2), max: +err[err.length - 1].toFixed(2) };
    const win = Math.min(256, size / 2), wx = Number(arg("view", "0,0,0").split(",")[0]) + HL, wy = Number(arg("view", "0,0,0").split(",")[1]) + HL;
    res.spectrum = wx + win <= S && wy + win <= S ? diagonalPower(height, S, wx, wy, win) : null;
    res.d2 = measures(height, S, x0 - HL, y0 - HL, per);
    res.shore = shoreHeights(height, S, live);
    res.dissection30 = dissection(height, cells, S, live, 30, per, cellM);
    for (const b of [per, per / 2, per / 4, per / 8]) res[`blockStep${b}`] = +blockStep(height, S, live, b, 0).toFixed(3);
    if (flag("diff")) {
      // the height difference to another run's state over the land, from the margin in: rms, and of its slopes' rms (the finer texture)
      const o = i32(`${LAND}/${arg("diff", "")}/state.i32`);
      let n = 0, sq = 0, ssq = 0, ssl = 0;
      for (let y = margin; y < size - margin; y++) for (let x = margin; x < size - margin; x++) {
        const k = (y + HL) * S + x + HL, ko = y * size + x;
        if (height[k] <= 0) continue;
        n++; const d = (height[k] - o[ko]) / 256; sq += d * d;
        const sl = (height[k + 1] - o[ko + 1] - (height[k - 1] - o[ko - 1])) / 256, sl2 = (height[k + S] - o[ko + size] - (height[k - S] - o[ko - size])) / 256;
        ssq += sl * sl + sl2 * sl2; ssl++;
      }
      res.diffRmsM = +Math.sqrt(sq / n).toFixed(1); res.diffSlopeRmsM = +Math.sqrt(ssq / ssl / 2).toFixed(2);
    }
    console.log(JSON.stringify(res));
    writeFileSync(join(work, "measures.json"), JSON.stringify(res));
    console.log(`rendered ${out} after ${m.steps} steps (${spent().toFixed(0)} s)`);
  } else {
    const maxSteps = schedule.length ? scheduled : Number(arg("steps", "20"));
    console.log(`creep substeps ${r.subs}`);
    let landCells = 0;
    for (let k = 0; k < S * S; k++) if (h[k] > 0) landCells++;
    let last = 0, curDt = schedule.length ? dtAt(m.steps) : dtMy;
    while (r.steps < maxSteps) {
      if (spent() + last * 1.3 + 25 > budget) break;
      const s0 = performance.now();
      if (schedule.length && dtAt(r.steps) !== curDt) { curDt = dtAt(r.steps); r.setTable(tableOf(planet, curDt)); }
      await r.step();
      last = (performance.now() - s0) / 1000;
      console.log(`step ${r.steps} ${last.toFixed(1)} s, dt ${curDt} My, flood ${r.lastRounds}, slide ${r.lastSlide}, mean loss ${((r.loss / 256 / (curDt * landCells))).toFixed(3)} m/My, ${JSON.stringify(Object.fromEntries(Object.entries(r.seconds).map(([k, v]) => [k, +v.toFixed(1)])))}`);
    }
    const st = await r.state();
    writeI32("state.i32", interiorOf(st.height)); writeI32("carry.i32", st.carry);
    writeFileSync(join(work, "meta.json"), JSON.stringify({ steps: r.steps, dtMy, nflow, schedule }));
    console.log(`${r.steps} of ${maxSteps} steps kept (${spent().toFixed(0)} s this call)`);
  }
  r.release();
} finally { await releaseGpu(); }
process.exit(0);
