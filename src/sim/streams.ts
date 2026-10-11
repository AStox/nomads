// Running water now. The generator gives every stream its mean flow and the share of it that comes out of the ground
// (src/terrain/water.ts); the ground's share runs all year, and the rest, the runoff, rises and falls with the season's
// rain and with the rain of the last day or two. A stream is as wide and deep as its flow now, and where that flow drops
// below a trickle only its dry bed is left.
import { TRICKLE, depthOf, flowNow, widthOf } from "../terrain/water";
import { SIZE, streamAt } from "../terrain/flora";
import { islandAir, meanRain, seasonAt } from "./air";
import { TILE_M, groundOf, type World } from "./world";

// Rain that runs off reaches the streams as a linear store that keeps this share of itself an hour on: surface runoff's
// recession constant, 0.3 to 0.8 a day (Pilgrim and Cordery, R224), taken at its middle, 0.55 [derived].
const KEEP = 0.55 ** (1 / 24);
// The runoff store an hour on (Weather.runoff, mm of the island's rain still to come down the streams) from tick t under
// a sky: what it held, receding, and the hour's rain.
export const runoffHour = (w: World, store: number | undefined, t: number, sky: World["weather"]["sky"]) =>
  (store ?? meanRain(w, t) / (1 - KEEP)) * KEEP + islandAir(w, t, sky).rain;
// The runoff now against its mean: the season's, drawn between the seasons as the air is, by the runoff store against
// what the season's mean rain keeps in it, so a stream rises with the rain of the last day or two as its share of the
// season's runoff would [derived: runoff taken as one share of the rain all season].
export function quickNow(w: World) {
  const { s, f } = seasonAt(w.t), q = groundOf(w.seed).isle.quick, store = w.weather.runoff;
  const season = q[s] * (1 - f) + q[(s + 1) % 4] * f, mean = meanRain(w, w.t) / (1 - KEEP);
  return store === undefined || mean <= 0 ? season : (season * store) / mean;
}
export type Stream = {
  q: number; // m³/s now
  width: number; depth: number; // of the water now, m
  bed: number; // width of the channel the stream keeps cut, m
  d: number; // meters from the point to the stream's middle
  flowing: boolean; // water runs at the point
};
// The stream at a point in tiles, if one runs within 20 m.
export function streamNow(w: World, px: number, py: number): Stream | null {
  const p = streamAt(groundOf(w.seed).fine, px * TILE_M - SIZE / 2, py * TILE_M - SIZE / 2);
  if (!p) return null;
  const q = flowNow(p.q, p.base, quickNow(w)), width = widthOf(q);
  return { q, width, depth: depthOf(q), bed: widthOf(p.hi), d: p.d, flowing: q >= TRICKLE && p.d <= width / 2 };
}
