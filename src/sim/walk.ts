// How anyone gets about: the least-time way across tiles where the ground, its slope, its snow or water is in the way
// (gait.ts), a straight line within them, sidestepping what is solid, at the speed the ground there lets them go. Tiles
// are 150 m.
import { H, TILE_M, W, dryAt, walkable, type World } from "./world";
import { around, put } from "./space";
import { FASTEST, legTime, radiusOf } from "./gait";
import { DAY } from "./sky";

export type Mover = { px: number; py: number; x: number; y: number; heading?: number };
type Pass = (w: World, x: number, y: number) => boolean;

// Allocated on first use: this module loads while world.ts, which defines W and H, is still loading.
let prev: Int32Array, queue: Int32Array, seen: Uint32Array, shut: Uint32Array, cost: Float64Array, heap: Int32Array, heapKey: Float64Array, stamp = 0;
function buffers() {
  if (prev) return;
  prev = new Int32Array(W * H); queue = new Int32Array(W * H); seen = new Uint32Array(W * H); shut = new Uint32Array(W * H);
  cost = new Float64Array(W * H); heap = new Int32Array(W * H * 8); heapKey = new Float64Array(W * H * 8);
}
const STEPS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
// A tile's middle's height, tile widths: its four corners' mean (world.ts heights).
const middle = (w: World, x: number, y: number) => (w.heights[y * (W + 1) + x] + w.heights[y * (W + 1) + x + 1] + w.heights[(y + 1) * (W + 1) + x] + w.heights[(y + 1) * (W + 1) + x + 1]) / 4;
// The first tile on the least-time way from one tile to another (or to one beside it, if it can't be stood on), or -1:
// A* over the tiles' middles, each leg as long as a grown, unladen walker takes over it (gait.ts legTime), and the rest of
// the way at least as long as the straight line at the fastest anyone goes.
function firstStep(w: World, from: number, goal: number, pass: Pass): number {
  const gx = goal % W, gy = (goal / W) | 0, open = pass(w, gx, gy), guess = (c: number) => (Math.hypot((c % W) - gx, ((c / W) | 0) - gy) * TILE_M) / FASTEST;
  buffers();
  stamp++;
  seen[from] = stamp; prev[from] = from; cost[from] = 0;
  let n = 0, found = -1;
  const push = (c: number, key: number) => {
    let i = n++;
    while (i > 0) { const up = (i - 1) >> 1; if (heapKey[up] <= key) break; heap[i] = heap[up]; heapKey[i] = heapKey[up]; i = up; }
    heap[i] = c; heapKey[i] = key;
  };
  const pop = () => {
    const top = heap[0], last = heap[--n], key = heapKey[n];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= n) break;
      if (c + 1 < n && heapKey[c + 1] < heapKey[c]) c++;
      if (heapKey[c] >= key) break;
      heap[i] = heap[c]; heapKey[i] = heapKey[c]; i = c;
    }
    heap[i] = last; heapKey[i] = key;
    return top;
  };
  push(from, guess(from));
  while (n > 0) {
    const c = pop(), cx = c % W, cy = (c / W) | 0;
    if (shut[c] === stamp) continue;
    shut[c] = stamp;
    if (c === goal || (!open && Math.max(Math.abs(cx - gx), Math.abs(cy - gy)) === 1)) { found = c; break; }
    const hc = middle(w, cx, cy);
    for (const [dx, dy] of STEPS) {
      const nx = cx + dx, ny = cy + dy, k = ny * W + nx;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H || shut[k] === stamp || !pass(w, nx, ny)) continue;
      const g = cost[c] + legTime(w, c, k, dx && dy ? Math.SQRT2 : 1, middle(w, nx, ny) - hc);
      if (seen[k] === stamp && g >= cost[k]) continue;
      seen[k] = stamp; prev[k] = c; cost[k] = g;
      if (n < heap.length) push(k, g + guess(k));
    }
  }
  if (found < 0) return -1;
  let c = found;
  while (prev[c] !== from && c !== from) c = prev[c];
  return c;
}

// The way on, kept until they move to another tile, head elsewhere, the ice changes or a day turns.
const routes = new WeakMap<object, { from: number; goal: number; ice: number; day: number; next: number }>();
function nextTile(w: World, e: Mover, goal: number, pass: Pass) {
  const from = e.y * W + e.x, r = routes.get(e), day = Math.floor(w.t / DAY);
  if (r && r.from === from && r.goal === goal && r.ice === w.ice.length && r.day === day) return r.next;
  const next = firstStep(w, from, goal, pass);
  routes.set(e, { from, goal, ice: w.ice.length, day, next });
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

// How someone goes: m/s over a stride from one point to another (in tiles), and, once it's taken, told of it and how
// long it took, s.
export type Pace = { speed(x0: number, y0: number, x1: number, y1: number): number; went?(x0: number, y0: number, x1: number, y1: number, s: number): void };
// Strides are looked at 2 m at a time for what's in the way, and what's solid is looked up afresh every 12 m [design].
const STRIDE = 2, LOOK = 20, RELOOK = 12;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
// Walk toward a point (in tiles) for so many seconds at the pace the ground gives, stopping within reach meters of it:
// how it went, and the seconds it took.
export function walk(w: World, e: Mover, tx: number, ty: number, pace: Pace, seconds: number, reach: number, pass: Pass = walkable): { r: "arrived" | "moved" | "stuck"; s: number } {
  const within = () => Math.hypot(tx - e.px, ty - e.py) * TILE_M <= reach;
  if (within()) return { r: "arrived", s: 0 };
  const gx = Math.floor(clamp(tx, 0, W - 1e-6)), gy = Math.floor(clamp(ty, 0, H - 1e-6)), goal = gy * W + gx, solid = solids();
  let left = seconds, moved = false;
  // as many strides as the time allows at the fastest anyone goes, and some to turn in
  for (let k = 0; left > 1e-6 && k < (seconds * FASTEST * 4) / STRIDE + 64; k++) {
    let wx = tx, wy = ty;
    const final = e.x === gx && e.y === gy;
    if (!final) {
      const next = nextTile(w, e, goal, pass);
      if (next < 0) return { r: "stuck", s: seconds - left };
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
    let step = Math.min(STRIDE / TILE_M, d);
    const a = clear(w, e, Math.atan2(wy - e.py, wx - e.px), step, WALK_TURNS, pass, dryAt, solid);
    if (a === null) break;
    const x0 = e.px, y0 = e.py, v = pace.speed(x0, y0, x0 + Math.cos(a) * step, y0 + Math.sin(a) * step);
    if (!(v > 0)) break;
    // what time is left takes them only part of a stride
    const s = Math.min(left, (step * TILE_M) / v);
    step = (s * v) / TILE_M;
    put(w, e, x0 + Math.cos(a) * step, y0 + Math.sin(a) * step);
    e.heading = a;
    left -= s;
    moved = true;
    pace.went?.(x0, y0, e.px, e.py, s);
    if (within()) return { r: "arrived", s: seconds - left };
  }
  return { r: within() ? "arrived" : moved ? "moved" : "stuck", s: seconds - left };
}
const WALK_TURNS = [0, 0.5, -0.5, 1, -1, 1.5, -1.5, 2.1, -2.1];

// What no one walks through, at its own size (gait.ts radiusOf): trees and stumps by their trunks, boulders and buildings
// by their width, a pit or a well by its mouth, a fire by its heap. Looked up round where someone is, and again once
// they have walked far enough that something now in their way might not have been round them.
const SOLID_KINDS = ["tree", "stump", "burnt_stump", "boulder", "structure", "well", "fire"];
type Solids = { at: [number, number] | null; near: { px: number; py: number; r: number }[] };
const solids = (): Solids => ({ at: null, near: [] });
function nearby(w: World, e: Mover, s: Solids) {
  if (s.at && Math.hypot(e.px - s.at[0], e.py - s.at[1]) * TILE_M <= RELOOK) return s.near;
  s.at = [e.px, e.py];
  s.near = [];
  around(w, e.px, e.py, LOOK, SOLID_KINDS, (t) => { s.near.push({ px: t.px, py: t.py, r: radiusOf(t) / TILE_M }); });
  return s.near;
}
// Whether a stride from one point to another (in tiles) runs into something solid. Leaving something one is already
// inside, say a hut just built around its builder, is always allowed.
function bumps(near: Solids["near"], x0: number, y0: number, x1: number, y1: number) {
  const dx = x1 - x0, dy = y1 - y0, l2 = dx * dx + dy * dy || 1e-12;
  for (const t of near) {
    const k = Math.max(0, Math.min(1, ((t.px - x0) * dx + (t.py - y0) * dy) / l2));
    if (Math.hypot(t.px - x0 - k * dx, t.py - y0 - k * dy) >= t.r) continue;
    if (Math.hypot(t.px - x0, t.py - y0) < t.r && Math.hypot(t.px - x1, t.py - y1) > Math.hypot(t.px - x0, t.py - y0)) continue;
    return true;
  }
  return false;
}
// The first heading, turning further and further from the one wanted, that a stride can take: onto a tile it can pass,
// a point it can stand on, and, for anyone who walks, not through anything solid.
function clear(w: World, e: Mover, a0: number, step: number, turns: number[], pass: Pass, point: Pass, solid: Solids | null): number | null {
  for (const turn of turns) {
    const a = a0 + turn, nx = e.px + Math.cos(a) * step, ny = e.py + Math.sin(a) * step;
    if (nx < 0 || ny < 0 || nx >= W || ny >= H || !pass(w, Math.floor(nx), Math.floor(ny)) || !point(w, nx, ny)) continue;
    if (solid && bumps(nearby(w, e, solid), e.px, e.py, nx, ny)) continue;
    return a;
  }
  return null;
}

// Head straight for a point, sidestepping when the way ahead can't be crossed. For animals and birds, which don't plan.
export function steer(w: World, e: Mover, tx: number, ty: number, speed: number, pass: Pass, point: Pass = () => true, solid = false): boolean {
  const d = Math.hypot(tx - e.px, ty - e.py), step = Math.min(speed / TILE_M, d);
  if (step < 1e-7) return false;
  const a = clear(w, e, Math.atan2(ty - e.py, tx - e.px), step, [0, 0.7, -0.7, 1.4, -1.4, 2.1, -2.1], pass, point, solid ? solids() : null);
  if (a === null) return false;
  put(w, e, e.px + Math.cos(a) * step, e.py + Math.sin(a) * step);
  e.heading = a;
  return true;
}
