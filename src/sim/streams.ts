// Running water now. The generator gives every stream its mean flow and the share of it that comes out of the ground
// (src/terrain/water.ts); the ground's share runs all year, and the rest, the runoff, rises and falls with the season's
// rain and with the rain of the last day or two. A stream is as wide and deep as its flow now, and where that flow drops
// below a trickle only its dry bed is left.
import { TRICKLE, depthOf, flowNow, widthOf } from "../terrain/water";
import { SIZE, streamAt } from "../terrain/flora";
import { seasonAt } from "./air";
import { TILE_M, groundOf, type World } from "./world";

// The runoff now against its mean: the season's, drawn between the seasons as the air is, swollen by recent rain, and
// a downpour's own, which runs off ground too dry to take it even in a dry season.
export function quickNow(w: World) {
  const { s, f } = seasonAt(w.t), q = groundOf(w.seed).isle.quick, wet = w.weather.wet;
  return (q[s] * (1 - f) + q[(s + 1) % 4] * f) * (0.6 + 2 * wet) + 0.5 * wet;
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
