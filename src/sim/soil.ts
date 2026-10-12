// The soil wherever something grows: its nourishment, the generator's fertility (src/terrain/ground.ts: the rock it
// weathered from, its silt, acidity, humus and depth), and what has happened to it since. Ash from a burn and the dung of
// animals and people feed it; taking what grows on it draws it down. Those changes are kept only where they happened, on
// cells of FERT_CELL meters, and fade as the rain washes them out and the ground settles back to what it was. And its
// water: the root zone's as the generator's seasons leave it, and the top soil's as each hour's rain and sun leave it.
import { CELL } from "../terrain/grid";
import { clamp, smooth } from "../terrain/flora";
import { esat } from "../terrain/climate";
import { holds } from "../terrain/ground";
import { FAUNA } from "./fauna";
import { CLOUD, islandAir, sunOn } from "./air";
import { seasonAt } from "./sky";
import { DAY, TILE_M, W, groundOf, type World } from "./world";

export const FERT_CELL = 25;
const across = () => Math.round((W * TILE_M) / FERT_CELL);
const cellOf = (px: number, py: number) => {
  const n = across(), x = clamp(Math.floor((px * TILE_M) / FERT_CELL), 0, n - 1), y = clamp(Math.floor((py * TILE_M) / FERT_CELL), 0, n - 1);
  return y * n + x;
};

// 0 for barren ground to about 1 for the richest silt, and past that where it has been fed.
export function fertilityAt(w: World, px: number, py: number) {
  const { isle, fine } = groundOf(w.seed);
  return Math.max(0, fine.bilinear(isle.fertility, (px * TILE_M) / CELL - 0.5, (py * TILE_M) / CELL - 0.5) + (w.fert[cellOf(px, py)] ?? 0));
}
// ---------- water ----------
// The warmth a surface at temp C glows away to a sky with this share hidden by cloud, less what the air glows back, holding
// vapour kPa: FAO-56's net longwave (R221 eq. 39), MJ/m2 an hour, the sky's clearness read as its sun's share of a clear
// sky's, no less than overcast's 0.25.
export const glowAway = (temp: number, vapour: number, cloud: number) =>
  (4.903e-9 / 24) * (temp + 273.16) ** 4 * (0.34 - 0.14 * Math.sqrt(vapour)) * (1.35 * Math.max(0.25, 1 - cloud) - 0.35);
// The reference evapotranspiration of an hour, mm (FAO-56's hourly Penman-Monteith over short grass, R221 eq. 53): air at
// temp C holding vapour kPa, sun W/m2 on the ground, a sky with cloud the share hidden, and a wind of u2 m/s at 2 m.
export function referenceEt(temp: number, vapour: number, sun: number, cloud: number, u2: number) {
  const es = esat(temp), slope = (4098 * es) / (temp + 237.3) ** 2, gamma = 0.000665 * 101.3;
  const net = 0.77 * sun * 0.0036 - glowAway(temp, vapour, cloud), soil = (sun > 0 ? 0.1 : 0.5) * net;
  return Math.max(0, (0.408 * slope * (net - soil) + gamma * (37 / (temp + 273)) * u2 * Math.max(0, es - vapour)) / (slope + gamma * (1 + 0.34 * u2)));
}
// The top 10 cm of soil (FAO-56 ch. 7, R221): it holds TEW of water the air can draw out of it, the first REW of that as
// fast as the air takes it (stage 1) and the rest the slower the drier it gets (stage 2, Kr = (TEW - De) / (TEW - REW)),
// at Kc max, 1.2 times the reference evapotranspiration, at most. A loam's REW 9 mm and TEW 19 mm, the middles of Table
// 19's 8 to 10 and 16 to 22 [analogue: the island's soils taken as loam].
export const REW = 9, TEW = 19;
const KC_MAX = 1.2;
// The share of the air's pull the top soil still meets, holding this share of TEW (FAO-56's Kr).
export function topKr(wet: number) {
  const taken = (1 - wet) * TEW;
  return taken <= REW ? 1 : Math.max(0, (TEW - taken) / (TEW - REW));
}
// How wet the top soil is an hour on (Weather.wet, the share of TEW still in it) from tick t under a sky, a wind over the
// open sea and a warmth: the island's rain soaks into it, whatever it can't hold draining on down, and the air draws on
// it as FAO-56 has it (open ground takes 0.6 of the sea's wind).
export function wetHour(w: World, wet: number, t: number, sky: World["weather"]["sky"], speed: number, temp: number) {
  const { vapour, rain } = islandAir(w, t, sky), soaked = Math.min(1, wet + rain / TEW);
  return Math.max(0, soaked - (topKr(soaked) * KC_MAX * referenceEt(temp, vapour, sunOn(t, sky), CLOUD[sky], speed * 0.6)) / TEW);
}
// How full the soil is at a point now, 0..1 (soilWater).
export const soilWaterAt = (w: World, px: number, py: number) => soilWater(w, px, py, w.t, w.weather.wet);
// How full the root zone is at a point at tick t with the top soil holding this share of what it can lose (Weather.wet),
// 0..1: the generator's seasonal bucket (ground.ts), drawn between the seasons' ends as the air is, and the top soil's
// water above or below what it holds at the end of stage 1, where the seasons' bucket, counting no single rain, leaves it
// [design], over all the root zone holds there (ground.ts holds), kept for the last point asked, which seedlings ask hour
// after hour.
let held = { seed: NaN, px: NaN, py: NaN, cap: 0 };
export function soilWater(w: World, px: number, py: number, t: number, wet: number) {
  const { isle, fine } = groundOf(w.seed), { s, f } = seasonAt(t), cx = (px * TILE_M) / CELL - 0.5, cy = (py * TILE_M) / CELL - 0.5;
  // a season's soil is as it stands at its end; its middle is halfway from the season before
  const end = (k: number) => fine.bilinear(isle.soilWater[(k + 4) % 4], cx, cy), mid = (k: number) => (end(k - 1) + end(k)) / 2;
  if (held.seed !== w.seed || held.px !== px || held.py !== py) {
    const at = (a: Float32Array) => fine.bilinear(a, cx, cy);
    held = { seed: w.seed, px, py, cap: holds(at(isle.soil), at(isle.sandy), at(isle.clayey), at(isle.humus)) };
  }
  return clamp(mid(s) * (1 - f) + mid(s + 1) * f + (TEW * wet - (TEW - REW)) / held.cap, 0, 1);
}
// How well a plant grows on the soil at a point: three quarters as fast on barren ground as on good soil, a quarter faster
// again on the richest.
export const feedRate = (w: World, px: number, py: number) => 0.75 + 0.5 * smooth(0, 0.5, fertilityAt(w, px, py));

// Feed the soil at a point (amount > 0) or draw it down (< 0), within half a unit either way of what it was.
export function enrich(w: World, px: number, py: number, amount: number) {
  const k = cellOf(px, py), v = clamp((w.fert[k] ?? 0) + amount, -0.5, 0.5);
  if (Math.abs(v) < 0.004) delete w.fert[k];
  else w.fert[k] = Math.round(v * 1e4) / 1e4;
}

// Once a day: every animal that walks the ground and every person leaves its dung where it is, and every change washes
// a little further out, three percent a day, so a burn's ash is half gone in some three weeks.
export function settle(w: World) {
  if (w.t % DAY !== DAY / 4) return;
  for (const an of w.animals) if (FAUNA[an.species].ground) enrich(w, an.px, an.py, 0.008);
  for (const a of w.agents) enrich(w, a.px, a.py, 0.01);
  for (const key of Object.keys(w.fert)) {
    const k = Number(key), v = w.fert[k] * 0.97;
    if (Math.abs(v) < 0.004) delete w.fert[k];
    else w.fert[k] = Math.round(v * 1e4) / 1e4;
  }
}
