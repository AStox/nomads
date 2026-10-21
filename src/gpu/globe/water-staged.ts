// A staged planet at tier 2 (1,024 cells a face, 96 tiles) for the water stage's tests and measures, with the planet's own flood and receivers (the regional kernels over a staged ridge
// along the cube's edge between faces 0 and 1) and everything the stage reads of it: the drift, the rock, a climate, and the global discharge. Three pits are cut in the ridge, one over
// a tile's edge and one over the face's edge, so that lakes cross both. The fields are what the stage's inputs are on the real planet; only their sources are staged [design].
import type { Gpu } from "../device";
import { defaultParams } from "./erosion";
import { FACES, centre, tierGrid } from "./grid";
import { dischargeOf } from "./discharge";
import { Regional, remapHeights, tierTable } from "./regional";
import { runTiles, type Ctx } from "./stages";
import type { BakeDir } from "./bakedir";
import { basinOf, climateFor, dischargeFields, surplusStage, type ClimateSource } from "./water";
import type { Planet } from "./window";

export const STAGED_TIER = 2;
const DEG = Math.PI / 180, g0 = tierGrid(0), g2 = tierGrid(STAGED_TIER), N0 = FACES * 256 * 256, N2 = FACES * g2.fn * g2.fn, CELLS2 = g2.fn * g2.fn;

// A ridge of 500 m along the cube's edge between faces 0 and 1 (the meridian at 45 degrees east), a plain of 30 m round it within 40 degrees of the equator, sea elsewhere.
function ridge(): Float32Array {
  const out = new Float32Array(N0);
  for (let f = 0, i = 0; f < FACES; f++)
    for (let Y = 0; Y < 256; Y++)
      for (let X = 0; X < 256; X++, i++) {
        const p = centre(g0, f, X, Y), lat = Math.asin(p[2]) / DEG, lon = Math.atan2(p[1], p[0]) / DEG, d = Math.abs(lon - 45);
        out[i] = Math.abs(lat) < 40 && d < 14 ? 30 + 470 * Math.exp(-((d / 6) ** 2)) : -1500;
      }
  return out;
}
// The pits: [face, X of the centre, Y of the centre, depth m] in the face's own cells; the second straddles a tile's edge (Y = 512), the third the face's edge between faces 0 and 1.
export const PITS: readonly (readonly [number, number, number, number])[] = [[0, 800, 300, 25], [0, 800, 512, 25], [0, 1024, 400, 25]];
const pitDepth = (face: number, X: number, Y: number): number => {
  let m = 0;
  for (const [f, cx, cy, depth] of PITS) {
    const dx = f === face ? X + 0.5 - cx : face === 1 && f === 0 && cx === 1024 ? X + 0.5 : NaN, dy = Y + 0.5 - cy, r = 5;
    if (!Number.isNaN(dx)) m = Math.max(m, depth * Math.exp(-((dx * dx + dy * dy) / (r * r))));
  }
  return m;
};

const hashOf = (k: number) => Math.imul(k ^ (k >>> 15), 2246822519) >>> 0;

// A climate that is a function of the cell alone (its height): a wetter, higher ridge and a dry plain, a wet winter and spring [design].
export const stagedClimate: ClimateSource = climateFor((h) => {
  const wet = [1.3, 0.8, 0.6, 1.3], pet = [0.3, 1.3, 1.6, 0.5], base = 30 + 0.25 * Math.max(0, h);
  return { precip: wet.map((w) => base * w), pet: pet.map((p) => 60 * p) };
});

export async function stagedPlanet(gpu: Gpu, dir: BakeDir, log: (s: string) => void = () => {}): Promise<Ctx> {
  const ctx: Ctx = { gpu, planet: {} as Planet, dir, tier: STAGED_TIER };
  if (dir.has("t2-cells.u32")) return ctx;
  const planet = { radius: g0.radius, pools: [0, 1, 2, 3, 4].map((k) => new Float32Array(N0).fill(k === 3 ? 2000 : 0)) } as unknown as Planet;
  const height = remapHeights(STAGED_TIER, ridge());
  for (let i = 0; i < N2; i++) {
    const f = Math.floor(i / CELLS2), r = i - f * CELLS2, Y = Math.floor(r / g2.fn), X = r - Y * g2.fn;
    if (height[i] > 0) height[i] = Math.max(1, height[i] - Math.round(pitDepth(f, X, Y) * 256));
  }
  const r = new Regional(gpu, STAGED_TIER, tierTable(planet, STAGED_TIER, defaultParams({ dtYr: 1e6 })), height, Int32Array.from({ length: N2 }, () => 256));
  try {
    await r.flow();
    dir.write("t2-height.i32", await r.readH());
    dir.write("t2-to.u32", new Uint32Array((await r.readField("TO")).buffer));
    dir.write("t2-flooded.i32", await r.readFlooded());
  } finally { r.release(); }
  // rock by the tier-0 cell it lies in, till of 4 m (clay or sandy by cell), bare rock on the heights
  const rock = new Uint8Array(N2), drift = new Uint8Array(N2), dd = new Uint16Array(N2), h = height;
  for (let i = 0; i < N2; i++) {
    const f = Math.floor(i / CELLS2), q = i - f * CELLS2, Y = Math.floor(q / g2.fn), X = q - Y * g2.fn, parent = (f * 256 + (Y >> STAGED_TIER)) * 256 + (X >> STAGED_TIER), hp = hashOf(parent);
    rock[i] = hp % 5;
    drift[i] = h[i] / 256 > 400 ? 0 : 1 + (hashOf(i >> 4) & 1);
    dd[i] = drift[i] === 0 ? 0 : 4096;
  }
  dir.write("t2-rock.u8", rock); dir.write("t2-drift.u8", drift); dir.write("t2-dd.u16", dd);
  const p = await runTiles(ctx, surplusStage(stagedClimate, STAGED_TIER), 250, log);
  if (!p.done) throw new Error("staged: the surplus tiles did not finish");
  const d = await dischargeOf(gpu, dir, STAGED_TIER, dischargeFields(STAGED_TIER), 250, log);
  log(`staged lakes: ${JSON.stringify(basinOf(ctx))}`);
  if (!d.done) throw new Error("staged: the discharge did not finish");
  return ctx;
}
