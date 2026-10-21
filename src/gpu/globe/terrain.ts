// The `terrain` tile stage: the rock at each cell's surface, and the drift (what the ice left on it) and its thickness, from the planet's rock pools and ice and the tier's
// heights, as window.ts and the island's upstream stage lay them for a window (R1701, R1703, R530) but per cell and with no window's edge in them.
//
// Outputs (global fields of the tier, cell order; `t<tier>-` is the tier's prefix, bakedir.ts tierFile):
//   rock.u8   the island's rock class at the surface (terrain/geology.ts ROCKS): the planet's pools laid as a stack and read down to the depth the cell lies under the
//             planet's own surface at its place (the tier-0 surface sampled to the cell; a valley floor lies deeper than a ridge, so it shows older rock)
//   drift.u8  geology.ts DRIFTS: bare rock, clay or sandy till; the planet has no meltwater valleys (the island's joint valleys are drawn by a window's key) [gap]
//   dd.u16    the drift's thickness in 1/1024 m, at most TILL_MOST_M
import { TILL_MAX } from "../../terrain/geology";
import { cover, dispatch, pipeline, readback, storage } from "../kernel";
import { terrainWgsl, TF, ZQ } from "../wgsl/globe-terrain";
import { tierFile } from "./bakedir";
import type { Ctx, Field, TileStage } from "./stages";
import { sampleCoarse } from "./sample";
import type { Patch } from "./patch";
import { TILL_MOST_M, rockAtDepth } from "./window";

// The reach: the blur's 12 cells (three passes of 4 to a side), rounded up to 16 cells [design].
export const TERRAIN_HALO = 16;
const q16 = (x: number) => Math.round(x * ZQ);

export async function terrainOf(ctx: Ctx, patch: Patch, height: Int32Array): Promise<{ rock: Uint8Array; drift: Uint8Array; dd: Uint16Array }> {
  const n = patch.ids.length, p = ctx.planet, g = ctx.gpu;
  const [surface, iceMax, laid, ...pools] = sampleCoarse(patch.tier, patch.ids, [p.height, p.ice.maxM, p.ice.laidM, ...p.pools]);
  const F = new Int32Array(TF.length * n), at = (name: (typeof TF)[number]) => TF.indexOf(name) * n;
  const rock = new Uint8Array(n), poolsAt = [0, 0, 0, 0, 0];
  for (let i = 0; i < n; i++) {
    const h = height[i] / 256;
    F[at("h") + i] = q16(h);
    F[at("land") + i] = height[i] > 0 ? 1 : 0;
    for (let k = 0; k < 5; k++) poolsAt[k] = pools[k][i];
    rock[i] = rockAtDepth(poolsAt, Math.max(0, surface[i] - h));
    F[at("rock") + i] = rock[i];
    F[at("till") + i] = q16(iceMax[i] > 0 ? Math.min(laid[i], TILL_MOST_M) : TILL_MAX);
  }
  const wgsl = terrainWgsl(patch.side), buf = storage(g, F);
  for (const e of ["blur0", "blur1", "blur2", "blur3", "blur4", "blur5", "till"]) dispatch(g, pipeline(g, wgsl, e), [buf], cover(g, n, 256));
  const out = new Int32Array(await readback(g, buf, 2 * n * 4, at("drift") * 4));
  buf.destroy();
  const drift = new Uint8Array(n), dd = new Uint16Array(n);
  for (let i = 0; i < n; i++) { drift[i] = out[i]; dd[i] = Math.min(65535, out[n + i] >> 6); }
  return { rock, drift, dd };
}

export const terrainStage = (tier: number, block = 1): TileStage => {
  const height = tierFile(tier, "height.i32"), rock = tierFile(tier, "rock.u8"), drift = tierFile(tier, "drift.u8"), dd = tierFile(tier, "dd.u16");
  return {
    name: "terrain",
    halo: TERRAIN_HALO,
    block,
    inputs: [height],
    outputs: [rock, drift, dd],
    async run(ctx, patch, input) {
      const r = await terrainOf(ctx, patch, input[height] as Int32Array);
      return { [rock]: r.rock as Field, [drift]: r.drift as Field, [dd]: r.dd as Field };
    },
  };
};
