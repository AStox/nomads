// Where every thing is: by id, by kind and tile, and which ones the world has to keep looking at. Every lookup that
// asks what lies near a point goes through here, so dense ground never costs a scan of the whole island.
//
// What the ground grew (trees, grass, rocks and the rest, a few million of them) stays in the generator's arrays
// (groundOf flora) until something first looks at its tile. Then the tile is stocked: its grown things become Things like
// any other, ids t1 upward by their place in the arrays. A stocked tile no one has looked at for a day, far from
// everyone, whose grown things are all still exactly as they grew, is put back: its Things go, to be made the same way
// the next time anything looks. What anyone made, dropped or changed stays.
import { DAY, H, TILE_M, W, groundOf, grown, type Thing, type World } from "./world";
import { FLORA, SPECIES, type Scatter } from "../terrain/flora";

type Index = {
  at: Map<string, number>; tiles: Map<string, (Thing[] | undefined)[]>; live: Set<Thing>;
  stocked: Uint8Array; // 1 where the tile's grown things are Things in w.things
  seen: Int32Array; // the tick something last looked at each tile
};
const indexes = new WeakMap<World, Index>();

// Plants and stones as the ground laid them out need nothing from the world until someone or something touches them.
const STILL: Record<string, true> = { tree: true, bush: true, boulder: true, stone: true, pebble: true, stick: true, fallen_log: true, mushroom: true, herb: true, reeds: true, fern: true, flowers: true, grass: true, clay: true };
export const BERRIES = 4; // the most a berry bush carries
const settled = (t: Thing) =>
  STILL[t.kind] && !t.burning && !t.scarred && !t.owner && (t.hp ?? 0) >= (t.maxHp ?? 0) && !(t.kind === "bush" && t.species === "berry" && (t.n ?? 0) < BERRIES);

function bucket(ix: Index, t: Thing) {
  let tiles = ix.tiles.get(t.kind);
  if (!tiles) ix.tiles.set(t.kind, (tiles = new Array(W * H)));
  (tiles[t.y * W + t.x] ??= []).push(t);
}
function unbucket(ix: Index, t: Thing) {
  const b = ix.tiles.get(t.kind)?.[t.y * W + t.x];
  const i = b ? b.indexOf(t) : -1;
  if (i < 0) return;
  b![i] = b![b!.length - 1];
  b!.pop();
}
function add(w: World, ix: Index, t: Thing, live: boolean) {
  ix.at.set(t.id, w.things.length);
  w.things.push(t);
  bucket(ix, t);
  if (live) ix.live.add(t);
}

export function index(w: World): Index {
  let ix = indexes.get(w);
  if (ix) return ix;
  ix = { at: new Map(), tiles: new Map(), live: new Set(), stocked: new Uint8Array(W * H), seen: new Int32Array(W * H) };
  // every kind the ground grows has its bins from the start, so stocking a tile mid-search never adds a list to search
  for (const k of FLORA) ix.tiles.set(k, new Array(W * H));
  for (const t of w.stocked) ix.stocked[t] = 1;
  for (let i = 0; i < w.things.length; i++) {
    const t = w.things[i];
    ix.at.set(t.id, i);
    bucket(ix, t);
    if (!settled(t)) ix.live.add(t);
  }
  indexes.set(w, ix);
  return ix;
}

// The tile entry k of the grown arrays stands on.
const tileOfGrown = (f: Scatter, k: number) => Math.min(H - 1, Math.floor(f.py[k])) * W + Math.min(W - 1, Math.floor(f.px[k]));
// Something looks at tile t: its grown things become Things, if they aren't yet.
function stock(w: World, ix: Index, t: number) {
  ix.seen[t] = w.t;
  if (ix.stocked[t]) return;
  ix.stocked[t] = 1;
  w.stocked.push(t);
  const f = groundOf(w.seed).flora;
  for (let k = f.start[t]; k < f.start[t + 1]; k++) { const th = grown(w, k); add(w, ix, th, !settled(th)); }
}
// Whether the tile a point is on has been looked at since it was last put back as it grew: its grown things are Things.
export const stockedAt = (w: World, px: number, py: number) => index(w).stocked[Math.min(H - 1, Math.floor(py)) * W + Math.min(W - 1, Math.floor(px))] === 1;
// The index into the grown arrays a thing id names, or -1 if it names something made since.
function grownIndex(w: World, id: string) {
  const k = Number(id.slice(1)) - 1;
  return id[0] === "t" && Number.isInteger(k) && k >= 0 && k < groundOf(w.seed).flora.n ? k : -1;
}

// A new thing enters the world. Things made after the ground was laid out are live from the start.
export function enter(w: World, t: Thing, live: boolean) {
  add(w, index(w), t, live);
}
export function leave(w: World, t: Thing) {
  const ix = index(w), i = ix.at.get(t.id);
  if (i === undefined) return;
  const last = w.things.pop()!;
  if (last !== t) { w.things[i] = last; ix.at.set(last.id, i); }
  ix.at.delete(t.id);
  unbucket(ix, t);
  ix.live.delete(t);
}
export const thingById = (w: World, id?: string | null) => {
  if (!id) return undefined;
  const ix = index(w);
  let i = ix.at.get(id);
  if (i === undefined) {
    // a grown thing on a tile nothing has looked at yet is still there as it grew
    const k = grownIndex(w, id), t = k < 0 ? -1 : tileOfGrown(groundOf(w.seed).flora, k);
    if (t < 0 || ix.stocked[t]) return undefined;
    stock(w, ix, t);
    i = ix.at.get(id);
    if (i === undefined) return undefined;
  }
  return w.things[i];
};
// Something happened to it: it changed kind, burned, got hurt, was picked. The world keeps an eye on it from now on.
export const wake = (w: World, t: Thing) => { const ix = index(w); if (ix.at.has(t.id)) ix.live.add(t); };
export const exists = (w: World, t: Thing) => { const i = index(w).at.get(t.id); return i !== undefined && w.things[i] === t; };
export const liveThings = (w: World) => index(w).live;
export function setKind(w: World, t: Thing, kind: Thing["kind"]) {
  const ix = index(w);
  if (ix.at.has(t.id)) unbucket(ix, t);
  t.kind = kind;
  if (ix.at.has(t.id)) { bucket(ix, t); ix.live.add(t); }
}

// The first thing of these kinds within r meters of the line walked from one point to another.
export function onPath(w: World, x0: number, y0: number, x1: number, y1: number, r: number, kinds: readonly string[], ok: (t: Thing) => boolean = () => true) {
  const dx = x1 - x0, dy = y1 - y0, l2 = dx * dx + dy * dy || 1e-12, len = Math.sqrt(l2) * TILE_M;
  let hit: Thing | null = null;
  around(w, (x0 + x1) / 2, (y0 + y1) / 2, len / 2 + r, kinds, (t) => {
    const k = Math.max(0, Math.min(1, ((t.px - x0) * dx + (t.py - y0) * dy) / l2));
    if (Math.hypot(t.px - x0 - k * dx, t.py - y0 - k * dy) * TILE_M <= r && ok(t)) { hit = t; return true; }
  });
  return hit as Thing | null;
}
// Move anything with a position, keeping its tile the floor of where it stands and its thing in the right bucket.
export function put(w: World, e: { px: number; py: number; x: number; y: number }, px: number, py: number) {
  px = Math.min(W - 1e-6, Math.max(0, px));
  py = Math.min(H - 1e-6, Math.max(0, py));
  const x = Math.floor(px), y = Math.floor(py);
  const t = "kind" in e && "id" in e ? (e as Thing) : null, ix = t ? index(w) : null;
  const moving = !!t && (x !== e.x || y !== e.y) && ix!.at.has(t.id);
  if (moving) unbucket(ix!, t!);
  e.px = px; e.py = py; e.x = x; e.y = y;
  if (moving) bucket(ix!, t!);
}

// Every thing of these kinds within r meters of a point, nearest tiles first. fn returns true to stop.
export function around(w: World, px: number, py: number, r: number, kinds: readonly string[] | null, fn: (t: Thing, d: number) => boolean | void) {
  const ix = index(w), rt = r / TILE_M;
  const x0 = Math.max(0, Math.floor(px - rt)), x1 = Math.min(W - 1, Math.floor(px + rt));
  const y0 = Math.max(0, Math.floor(py - rt)), y1 = Math.min(H - 1, Math.floor(py + rt));
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) stock(w, ix, y * W + x);
  const lists = kinds ? kinds.map((k) => ix.tiles.get(k)).filter((l) => !!l) : [...ix.tiles.values()];
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++)
      for (const tiles of lists) {
        const b = tiles![y * W + x];
        if (!b) continue;
        for (const t of b) {
          const d = Math.hypot(t.px - px, t.py - py) * TILE_M;
          if (d <= r && fn(t, d)) return;
        }
      }
}
export function anyAround(w: World, px: number, py: number, r: number, kinds: readonly string[] | null, ok: (t: Thing) => boolean = () => true) {
  let hit: Thing | null = null;
  around(w, px, py, r, kinds, (t) => { if (ok(t)) { hit = t; return true; } });
  return hit as Thing | null;
}
// The nearest thing of these kinds that passes ok, searching outward ring by ring of tiles, out to max meters.
export function nearestThing(w: World, px: number, py: number, kinds: readonly string[], ok: (t: Thing) => boolean = () => true, max = Infinity): Thing | null {
  const ix = index(w), lists = kinds.map((k) => ix.tiles.get(k)).filter((l) => !!l);
  if (!lists.length) return null;
  const qx = Math.floor(px), qy = Math.floor(py);
  let best: Thing | null = null, bd = max;
  for (let R = 0; R < Math.max(W, H); R++) {
    if ((R - 1) * TILE_M > bd) break;
    for (let y = qy - R; y <= qy + R; y++) {
      if (y < 0 || y >= H) continue;
      const edge = y === qy - R || y === qy + R;
      for (let x = qx - R; x <= qx + R; x += edge || R === 0 ? 1 : 2 * R) {
        if (x < 0 || x >= W) continue;
        stock(w, ix, y * W + x);
        for (const tiles of lists) {
          const b = tiles![y * W + x];
          if (!b) continue;
          for (const t of b) {
            const d = Math.hypot(t.px - px, t.py - py) * TILE_M;
            if (d < bd && ok(t)) { bd = d; best = t; }
          }
        }
      }
    }
  }
  return best;
}
// The grown things of each kind, as indexes into the grown arrays, gathered the first time a kind is asked for.
const ofKind = new WeakMap<Scatter, Map<string, Uint32Array>>();
function grownOfKind(f: Scatter, kind: string) {
  let m = ofKind.get(f);
  if (!m) ofKind.set(f, (m = new Map()));
  let list = m.get(kind);
  if (!list) {
    const code = FLORA.indexOf(kind as (typeof FLORA)[number]);
    let n = 0;
    for (let k = 0; k < f.n; k++) if (f.kind[k] === code) n++;
    list = new Uint32Array(n);
    for (let k = 0, j = 0; k < f.n; k++) if (f.kind[k] === code) list[j++] = k;
    m.set(kind, list);
  }
  return list;
}
// A thing of this kind picked at random over the island, or null when there are none.
export function anyOf(w: World, kind: string, rand = Math.random): Thing | null {
  const list = grownOfKind(groundOf(w.seed).flora, kind);
  for (let tries = 0; tries < 16 && list.length; tries++) {
    const t = thingById(w, `t${list[Math.floor(rand() * list.length)] + 1}`);
    if (t?.kind === kind) return t;
  }
  // none grew, or the ones tried are gone: one of those made or changed since
  const tiles = index(w).tiles.get(kind);
  if (!tiles) return null;
  for (let tries = 0; tries < 64 && w.things.length; tries++) {
    const t = w.things[Math.floor(rand() * w.things.length)];
    if (t?.kind === kind) return t;
  }
  const all = tiles.flatMap((b) => b ?? []);
  return all[Math.floor(rand() * all.length)] ?? null;
}

// Whether a thing is exactly as it was grown, field for field.
function same(a: Thing, b: Thing) {
  const x = a as Record<string, unknown>, y = b as Record<string, unknown>;
  const kx = Object.keys(x).filter((k) => x[k] !== undefined), ky = Object.keys(y).filter((k) => y[k] !== undefined);
  if (kx.length !== ky.length) return false;
  for (const k of kx) {
    const u = x[k], v = y[k];
    if (u === v) continue;
    if (!u || !v || typeof u !== "object" || typeof v !== "object" || JSON.stringify(u) !== JSON.stringify(v)) return false;
  }
  return true;
}
// Once a day: put back every stocked tile nothing has looked at for a day, with no one within a kilometer, whose grown
// things are all still exactly as they grew. Their Things go; the grown arrays hold them as they are.
export function shelve(w: World) {
  const ix = index(w), f = groundOf(w.seed).flora, near = 1000 / TILE_M, kept: number[] = [];
  for (const t of w.stocked) {
    const x = t % W + 0.5, y = Math.floor(t / W) + 0.5;
    let asGrown = w.t - ix.seen[t] >= DAY && !w.agents.some((a) => Math.abs(a.px - x) < near && Math.abs(a.py - y) < near);
    for (let k = f.start[t]; asGrown && k < f.start[t + 1]; k++) {
      const i = ix.at.get(`t${k + 1}`);
      asGrown = i !== undefined && same(w.things[i], grown(w, k));
    }
    if (!asGrown) { kept.push(t); continue; }
    for (let k = f.start[t]; k < f.start[t + 1]; k++) leave(w, w.things[ix.at.get(`t${k + 1}`)!]);
    ix.stocked[t] = 0;
  }
  w.stocked = kept;
}

// Everything in the world, for drawing. The grown arrays are shared as they are, not copied; `gone` lists the grown
// things that are no longer there, and `things` every thing the world holds that the arrays don't show as it is: what
// was made since, and grown things changed. Kind and species codes in the arrays index kindNames and speciesNames.
export type Objects = { grown: Scatter; kindNames: string[]; speciesNames: string[]; gone: number[]; things: Thing[] };
export function objects(w: World): Objects {
  const ix = index(w), f = groundOf(w.seed).flora, gone: number[] = [], things: Thing[] = [];
  for (const t of w.stocked)
    for (let k = f.start[t]; k < f.start[t + 1]; k++) {
      const i = ix.at.get(`t${k + 1}`);
      if (i === undefined) gone.push(k + 1);
      else if (!same(w.things[i], grown(w, k))) things.push(w.things[i]);
    }
  for (const t of w.things) if (grownIndex(w, t.id) < 0) things.push(t);
  return { grown: f, kindNames: [...FLORA], speciesNames: [...SPECIES], gone, things };
}
