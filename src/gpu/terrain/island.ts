// The island generator: the crust, its erosion, the ice's scour and till and the hollows (upstream.ts in this directory),
// then the climate, the water and the ground (rain.ts, climate.ts, water.ts, ground.ts): every stage a GPU kernel. The
// stages run in the order the generator has always had them and take each other's fields as Float32Arrays, so what comes
// out is an Island as every reader of one expects. The GPU's answers come back asynchronously, so an island is made with
// await (world.ts islandOf is the game's way to it). A window of the planet (gpu/globe/window.ts) runs the same stages from
// its own upstream, under the parameters its place gives them (generateWindow).
import type { Gpu } from "../device";
import { PEAT } from "../../terrain/geology";
import { LEN } from "../../terrain/grid";
import { ROSE, WET_ROSE, meanWay, turned, type Climate } from "../../terrain/climate";
import type { Island, Upstream, Watch } from "../../terrain/island";
import { rainGpu, type Delays, type RainSeason } from "./rain";
import { climateRestGpu, type ClimatePlace } from "./climate";
import { hydrologyGpu, type Inflow } from "./water";
import { groundGpu } from "./ground";
import { upstreamGpu } from "./upstream";
import { WINDOW_WATER } from "../wgsl/terrain-water";

// Weather, sun and the hills' shade over a height field: the one draw is the way the wind prevails; the rain is rainGpu's
// and the rest climateRestGpu's.
export async function climateGpu(g: Gpu, height: Float32Array, open: Uint8Array, rand: () => number): Promise<Climate> {
  const prevailing = rand() * Math.PI * 2, shift = prevailing - meanWay(ROSE), wetRose = turned(WET_ROSE, shift);
  const z = new Float32Array(LEN);
  for (let i = 0; i < LEN; i++) z[i] = Math.max(0, height[i]);
  const rain = await rainGpu(g, z, wetRose);
  return climateOf(g, height, open, rain, prevailing);
}
async function climateOf(g: Gpu, height: Float32Array, open: Uint8Array, rain: Float32Array[], angle: number, place?: ClimatePlace): Promise<Climate> {
  const rest = await climateRestGpu(g, { height, open, precip: rain, angle, place });
  const precip = new Float32Array(LEN);
  for (const r of rain) for (let i = 0; i < LEN; i++) precip[i] += r[i];
  const { seasons, ...year } = rest;
  return { ...year, precip, seasons: seasons.map((s, si) => ({ precip: rain[si], ...s })) };
}

// The water and the ground over a climate: the stages after the climate, the island's and a window's alike.
async function waterAndGround(g: Gpu, up: Upstream, air: Climate, watch?: Watch, inflow?: readonly Inflow[]): Promise<Island> {
  const { land, rock, height, drift, driftDepth, filled, to, basin, hollow, open } = up;
  const hy = inflow ? await hydrologyGpu(g, { h: height, filled, to, basin, rock, drift, driftDepth, air, inflow }, WINDOW_WATER) : await hydrologyGpu(g, { h: height, filled, to, basin, rock, drift, driftDepth, air });
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

export async function generateIsland(rand: () => number, g: Gpu, watch?: Watch): Promise<Island> {
  const up = await upstreamGpu(g, rand, watch);
  const air = await climateGpu(g, up.height, up.open, rand);
  watch?.({ stage: "climate", height: up.height, precip: air.precip, temp: air.temp, snow: air.snowCover, wind: air.wind });
  return waterAndGround(g, up, air, watch);
}

// What a window's stages after the upstream take from its place (gpu/globe/window.ts windowParams makes it):
export type WindowStages = {
  rainZ: Float32Array; // the heights the orographic rain is reckoned on, m: the window's relief below the planet's own (whose rain the background is)
  rain: RainSeason[]; delays: Delays[]; // the rain stage's seasons and cloud delays
  // each season's rain as the rain stage made it, mm over the season, to the window's (a conservative remap to the planet's)
  scaleRain: (rain: Float32Array[]) => Float32Array[];
  place: (rain: Float32Array[]) => ClimatePlace; angle: number; // the climate's seasons, latitude, rose and snow words for the rain made; the prevailing wind's way (radians, code bearings)
  inflow: readonly Inflow[]; // rivers from beyond the edge
};
// A window's climate, water and ground on its upstream: the island's stages with its place's parameters.
export async function generateWindow(g: Gpu, up: Upstream, w: WindowStages, watch?: Watch): Promise<Island> {
  const rain = w.scaleRain(await rainGpu(g, w.rainZ, w.rain[0].rose, w.delays, w.rain));
  const air = await climateOf(g, up.height, up.open, rain, w.angle, w.place(rain));
  watch?.({ stage: "climate", height: up.height, precip: air.precip, temp: air.temp, snow: air.snowCover, wind: air.wind });
  return waterAndGround(g, up, air, watch, w.inflow);
}
