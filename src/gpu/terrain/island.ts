// The island's climate, water and ground made on the GPU (src/gpu/terrain/rain.ts, climate.ts, water.ts, ground.ts), after
// the crust, its erosion, the ice's scour and till and the hollows (src/terrain/island.ts upstream). The stages run in the
// order the generator has always had them and take each other's fields as the generator's own Float32Arrays, so what comes
// out is an Island as every reader of one expects.
import type { Gpu } from "../device";
import { PEAT } from "../../terrain/geology";
import { LEN } from "../../terrain/grid";
import { ROSE, WET_ROSE, meanWay, turned, type Climate } from "../../terrain/climate";
import { upstream, type Island, type Watch } from "../../terrain/island";
import { rainGpu } from "./rain";
import { climateRestGpu } from "./climate";
import { hydrologyGpu } from "./water";
import { groundGpu } from "./ground";

// Weather, sun and the hills' shade over a height field (src/terrain/climate.ts climate): the one draw is the way the wind
// prevails, as the generator has always made it; the rain is rainGpu's and the rest climateRestGpu's.
export async function climateGpu(g: Gpu, height: Float32Array, open: Uint8Array, rand: () => number): Promise<Climate> {
  const prevailing = rand() * Math.PI * 2, shift = prevailing - meanWay(ROSE), wetRose = turned(WET_ROSE, shift);
  const z = new Float32Array(LEN);
  for (let i = 0; i < LEN; i++) z[i] = Math.max(0, height[i]);
  const rain = await rainGpu(g, z, wetRose);
  const rest = await climateRestGpu(g, { height, open, precip: rain, angle: prevailing });
  const precip = new Float32Array(LEN);
  for (const r of rain) for (let i = 0; i < LEN; i++) precip[i] += r[i];
  const { seasons, ...year } = rest;
  return { ...year, precip, seasons: seasons.map((s, si) => ({ precip: rain[si], ...s })) };
}

export async function generateIslandGpu(rand: () => number, g: Gpu, watch?: Watch): Promise<Island> {
  const { land, rock, height, drift, driftDepth, filled, to, basin, hollow, open } = upstream(rand, watch);
  const air = await climateGpu(g, height, open, rand);
  watch?.({ stage: "climate", height, precip: air.precip, temp: air.temp, snow: air.snowCover, wind: air.wind });
  const hy = await hydrologyGpu(g, { h: height, filled, to, basin, rock, drift, driftDepth, air });
  watch?.({ stage: "water", height, water: hy.water, table: hy.table, rivers: hy.rivers, springs: hy.springs, quick: hy.quick });
  for (let i = 0; i < LEN; i++) {
    open[i] = hy.water[i] > 0 ? 1 : 0;
    // a hollow that holds no lake is overgrown to bog (R528); ground.ts grows its peat where the water table stays high
    if (land[i] && !open[i] && hollow[i] >= 0) drift[i] = PEAT;
  }
  const cover = await groundGpu(g, { ...air, height, open, seasonTable: hy.seasonTable, winterTable: hy.winterTable, dryTable: hy.dryTable, valley: hy.valley, channel: hy.channel, power: hy.power, driftDepth, drift, rock });
  if (watch) {
    watch({ stage: "soil", height, water: hy.water, rock, ph: cover.ph, fertility: cover.fertility });
    watch({ stage: "cover", height, water: hy.water, tree: cover.tree, shrub: cover.shrub, grass: cover.grass, marsh: cover.marsh, bare: cover.bare, sand: cover.sand });
  }
  return { ...air, ...cover, ...hy, height, rock, drift, driftDepth };
}
