// How anyone gets about: a route across tiles where water is in the way, a straight line within them, and so many
// meters a tick. Tiles are 150 m, so most walks never leave the tile they start on.
import { H, TILE_M, W, dryAt, walkable, type Thing, type World } from "./world";
import { around, put } from "./space";

export type Mover = { px: number; py: number; x: number; y: number; heading?: number };
type Pass = (w: World, x: number, y: number) => boolean;

// Allocated on first use: this module loads while world.ts, which defines W and H, is still loading.
let prev: Int32Array, queue: Int32Array, seen: Uint32Array, stamp = 0;
function buffers() { if (!prev) { prev = new Int32Array(W * H); queue = new Int32Array(W * H); seen = new Uint32Array(W * H); } }
const STEPS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
// The first tile on the shortest way from one tile to another (or next to it, if it can't be stood on), or -1.
function firstStep(w: World, from: number, goal: number, pass: Pass): number {
  const gx = goal % W, gy = (goal / W) | 0, open = pass(w, gx, gy);
  buffers();
  stamp++;
  seen[from] = stamp; prev[from] = from;
  let head = 0, tail = 0, found = -1;
  queue[tail++] = from;
  while (head < tail && found < 0) {
    const c = queue[head++], cx = c % W, cy = (c / W) | 0;
    if (!open && Math.max(Math.abs(cx - gx), Math.abs(cy - gy)) === 1) { found = c; break; }
    for (const [dx, dy] of STEPS) {
      const nx = cx + dx, ny = cy + dy, n = ny * W + nx;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H || seen[n] === stamp || !pass(w, nx, ny)) continue;
      seen[n] = stamp; prev[n] = c;
      if (n === goal) { found = n; break; }
      queue[tail++] = n;
    }
  }
  if (found < 0) return -1;
  let c = found;
  while (prev[c] !== from) c = prev[c];
  return c;
}

const routes = new WeakMap<object, { from: number; goal: number; ice: number; next: number }>();
function nextTile(w: World, e: Mover, goal: number, pass: Pass) {
  const from = e.y * W + e.x, r = routes.get(e);
  if (r && r.from === from && r.goal === goal && r.ice === w.ice.length) return r.next;
  const next = firstStep(w, from, goal, pass);
  routes.set(e, { from, goal, ice: w.ice.length, next });
  return next;
}

// Which stretch of walkable ground each tile belongs to (0 for water), so no one sets out for what they can't reach.
const lands = new WeakMap<World, { ice: number; label: Uint16Array }>();
export function landOf(w: World) {
  const c = lands.get(w);
  if (c && c.ice === w.ice.length) return c.label;
  buffers();
  const label = new Uint16Array(W * H);
  let next = 0;
  for (let s = 0; s < W * H; s++) {
    if (label[s] || !walkable(w, s % W, (s / W) | 0)) continue;
    label[s] = ++next;
    let tail = 0;
    queue[tail++] = s;
    for (let head = 0; head < tail; head++) {
      const cx = queue[head] % W, cy = (queue[head] / W) | 0;
      for (const [dx, dy] of STEPS) {
        const nx = cx + dx, ny = cy + dy, n = ny * W + nx;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H || label[n] || !walkable(w, nx, ny)) continue;
        label[n] = next;
        queue[tail++] = n;
      }
    }
  }
  lands.set(w, { ice: w.ice.length, label });
  return label;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
// Walk toward a point (in tiles) at so many meters a tick, stopping within reach meters of it.
export function walk(w: World, e: Mover, tx: number, ty: number, speed: number, reach: number, pass: Pass = walkable): "arrived" | "moved" | "stuck" {
  const within = () => Math.hypot(tx - e.px, ty - e.py) * TILE_M <= reach;
  if (within()) return "arrived";
  let budget = speed / TILE_M, moved = false;
  const gx = Math.floor(clamp(tx, 0, W - 1e-6)), gy = Math.floor(clamp(ty, 0, H - 1e-6)), goal = gy * W + gx;
  for (let hop = 0; hop < 4 && budget > 1e-9; hop++) {
    let wx = tx, wy = ty;
    const final = e.x === gx && e.y === gy;
    if (!final) {
      const next = nextTile(w, e, goal, pass);
      if (next < 0) return "stuck";
      const nx = next % W, ny = (next / W) | 0, dx = nx - e.x, dy = ny - e.y;
      if (!pass(w, gx, gy) && next === e.y * W + e.x) { wx = clamp(tx, e.x, e.x + 0.9999); wy = clamp(ty, e.y, e.y + 0.9999); }
      else if (dx && dy) {
        // Across a corner: aim at the corner itself, so the line never clips the tiles on either side.
        wx = e.x + (dx > 0 ? 1 : 0) + dx * 1e-4; wy = e.y + (dy > 0 ? 1 : 0) + dy * 1e-4;
      } else { wx = clamp(tx, nx + 0.001, nx + 0.999); wy = clamp(ty, ny + 0.001, ny + 0.999); }
    }
    let d = Math.hypot(wx - e.px, wy - e.py);
    // Don't walk into what you're going to: stop a little short of it.
    if (final || (wx === tx && wy === ty)) d = Math.max(0, d - (reach * 0.7) / TILE_M);
    if (d < 1e-7) break;
    const step = Math.min(budget, d), a = clear(w, e, Math.atan2(wy - e.py, wx - e.px), step, WALK_TURNS, pass, dryAt, true);
    if (a === null) break;
    put(w, e, e.px + Math.cos(a) * step, e.py + Math.sin(a) * step);
    e.heading = a;
    budget -= step;
    moved = true;
    if (within()) return "arrived";
  }
  return within() ? "arrived" : moved ? "moved" : "stuck";
}
const WALK_TURNS = [0, 0.5, -0.5, 1, -1, 1.5, -1.5, 2.1, -2.1];

// What no one walks through, and how far out from its middle it stands, in meters.
const SOLID: Record<string, (t: Thing) => number> = {
  tree: () => 0.35, stump: () => 0.3, burnt_stump: () => 0.3, boulder: (t) => t.size / 2, structure: (t) => t.size / 2, well: () => 0.75, fire: () => 0.45,
};
const SOLID_KINDS = Object.keys(SOLID);
// Whether a stride from one point to another (in tiles) runs into something solid. Leaving something one is already
// inside, say a hut just built around its builder, is always allowed.
function bumps(w: World, x0: number, y0: number, x1: number, y1: number) {
  const dx = x1 - x0, dy = y1 - y0, l2 = dx * dx + dy * dy || 1e-12, len = Math.sqrt(l2) * TILE_M;
  let hit = false;
  around(w, (x0 + x1) / 2, (y0 + y1) / 2, len / 2 + 3, SOLID_KINDS, (t) => {
    const r = SOLID[t.kind](t) / TILE_M, k = Math.max(0, Math.min(1, ((t.px - x0) * dx + (t.py - y0) * dy) / l2));
    if (Math.hypot(t.px - x0 - k * dx, t.py - y0 - k * dy) >= r) return;
    if (Math.hypot(t.px - x0, t.py - y0) < r && Math.hypot(t.px - x1, t.py - y1) > Math.hypot(t.px - x0, t.py - y0)) return;
    hit = true;
    return true;
  });
  return hit;
}
// The first heading, turning further and further from the one wanted, that a stride can take: onto a tile it can pass,
// a point it can stand on, and, for anyone who walks, not through anything solid.
function clear(w: World, e: Mover, a0: number, step: number, turns: number[], pass: Pass, point: Pass, solid: boolean): number | null {
  for (const turn of turns) {
    const a = a0 + turn, nx = e.px + Math.cos(a) * step, ny = e.py + Math.sin(a) * step;
    if (nx < 0 || ny < 0 || nx >= W || ny >= H || !pass(w, Math.floor(nx), Math.floor(ny)) || !point(w, nx, ny)) continue;
    if (solid && bumps(w, e.px, e.py, nx, ny)) continue;
    return a;
  }
  return null;
}

// Head straight for a point, sidestepping when the way ahead can't be crossed. For animals and birds, which don't plan.
export function steer(w: World, e: Mover, tx: number, ty: number, speed: number, pass: Pass, point: Pass = () => true, solid = false): boolean {
  const d = Math.hypot(tx - e.px, ty - e.py), step = Math.min(speed / TILE_M, d);
  if (step < 1e-7) return false;
  const a = clear(w, e, Math.atan2(ty - e.py, tx - e.px), step, [0, 0.7, -0.7, 1.4, -1.4, 2.1, -2.1], pass, point, solid);
  if (a === null) return false;
  put(w, e, e.px + Math.cos(a) * step, e.py + Math.sin(a) * step);
  e.heading = a;
  return true;
}
