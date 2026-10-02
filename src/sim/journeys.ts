// Hero paths (world.ts Journey): where every person has been and what happened to them there, kept for good.
import { QUIET, TILE_M, type World } from "./world";

const STRIDE = 3 / TILE_M; // tiles: a new point once they are this far from the last
const BEND = 1 / TILE_M; // tiles: a point that strays less than this from the line past it adds nothing
const r3 = (v: number) => Math.round(v * 1000) / 1000;
// per world, per person: the points passed since their path's second-last point
const between = new WeakMap<World, Map<string, [number, number][]>>();

// Once a tick, after everyone has moved: a point for whoever has gone far enough, and a flag for each event since the
// last one pinned. A world saved before there were paths starts them now, with nothing behind them.
export function travel(w: World) {
  const J = (w.journeys ??= { seen: w.events.at(-1)?.id ?? 0, of: {} });
  for (const a of w.agents) {
    const j = J.of[a.id];
    if (!j) { J.of[a.id] = { x: [r3(a.px)], y: [r3(a.py)], t: [w.t], marks: [] }; continue; }
    const n = j.x.length - 1;
    if (Math.hypot(a.px - j.x[n], a.py - j.y[n]) < STRIDE) continue;
    // On a straight stretch the last point is only a waypoint: move it on rather than add one, so long as every point
    // they passed since the one before it still lies on the line. Those passed points are only held while the world is
    // in memory; after a reload the path just goes on from its last point.
    const since = (between.get(w) ?? between.set(w, new Map()).get(w)!).get(a.id);
    if (n >= 1 && since && since.every(([x, y]) => off(j.x[n - 1], j.y[n - 1], a.px, a.py, x, y) < BEND)) {
      j.x[n] = r3(a.px); j.y[n] = r3(a.py); j.t[n] = w.t;
      since.push([a.px, a.py]);
    } else {
      j.x.push(r3(a.px)); j.y.push(r3(a.py)); j.t.push(w.t);
      between.get(w)!.set(a.id, [[a.px, a.py]]);
    }
  }
  let i = w.events.length;
  while (i > 0 && w.events[i - 1].id > J.seen) i--;
  for (let k = i; k < w.events.length; k++) {
    const e = w.events[k];
    if (QUIET[e.kind]) continue;
    for (const id of new Set(e.who)) {
      const j = J.of[id], a = w.agents.find((x) => x.id === id);
      if (j) j.marks.push({ px: r3(a ? a.px : e.x + 0.5), py: r3(a ? a.py : e.y + 0.5), t: e.t, kind: e.kind, text: e.text });
    }
  }
  J.seen = w.events.at(-1)?.id ?? J.seen;
}
// how far (px, py) lies from the segment from (ax, ay) to (bx, by)
function off(ax: number, ay: number, bx: number, by: number, px: number, py: number) {
  const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy, t = L ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L)) : 0;
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}
// meters walked along a path
export const walked = (j: { x: number[]; y: number[] }) => { let m = 0; for (let i = 1; i < j.x.length; i++) m += Math.hypot(j.x[i] - j.x[i - 1], j.y[i] - j.y[i - 1]); return m * TILE_M; };
