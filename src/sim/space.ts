// Where every thing is: by id, by kind and tile, and which ones the world has to keep looking at. Every lookup that
// asks what lies near a point goes through here, so dense ground never costs a scan of the whole island.
import { H, TILE_M, W, type Thing, type World } from "./world";

type Index = { at: Map<string, number>; tiles: Map<string, (Thing[] | undefined)[]>; live: Set<Thing> };
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

export function index(w: World): Index {
  let ix = indexes.get(w);
  if (ix) return ix;
  ix = { at: new Map(), tiles: new Map(), live: new Set() };
  for (let i = 0; i < w.things.length; i++) {
    const t = w.things[i];
    ix.at.set(t.id, i);
    bucket(ix, t);
    if (!settled(t)) ix.live.add(t);
  }
  indexes.set(w, ix);
  return ix;
}

// A new thing enters the world. Things made after the ground was laid out are live from the start.
export function enter(w: World, t: Thing, live: boolean) {
  const ix = index(w);
  ix.at.set(t.id, w.things.length);
  w.things.push(t);
  bucket(ix, t);
  if (live) ix.live.add(t);
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
  const i = index(w).at.get(id);
  return i === undefined ? undefined : w.things[i];
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
export const countOf = (w: World, kind: string) => {
  let n = 0;
  for (const b of index(w).tiles.get(kind) ?? []) n += b?.length ?? 0;
  return n;
};
// A thing of this kind picked at random over the whole island, or null when there are none.
export function anyOf(w: World, kind: string, rand = Math.random): Thing | null {
  const tiles = index(w).tiles.get(kind);
  if (!tiles) return null;
  for (let tries = 0; tries < 64; tries++) {
    const t = w.things[Math.floor(rand() * w.things.length)];
    if (t?.kind === kind) return t;
  }
  const all = tiles.flatMap((b) => b ?? []);
  return all[Math.floor(rand() * all.length)] ?? null;
}

// Every thing in the world as flat arrays, for drawing: kind and species are indices into the name tables. species
// holds the item for loose items and the building style for structures.
export type Objects = {
  id: Uint32Array; kind: Uint8Array; species: Uint8Array; px: Float32Array; py: Float32Array; size: Float32Array; seed: Uint32Array;
  kindNames: string[]; speciesNames: string[];
};
export function objects(w: World): Objects {
  const n = w.things.length, kindNames: string[] = [], speciesNames = [""];
  const kinds = new Map<string, number>(), species = new Map<string, number>([["", 0]]);
  const of = (m: Map<string, number>, names: string[], k: string) => { let i = m.get(k); if (i === undefined) { i = names.length; names.push(k); m.set(k, i); } return i; };
  const o: Objects = { id: new Uint32Array(n), kind: new Uint8Array(n), species: new Uint8Array(n), px: new Float32Array(n), py: new Float32Array(n), size: new Float32Array(n), seed: new Uint32Array(n), kindNames, speciesNames };
  for (let i = 0; i < n; i++) {
    const t = w.things[i];
    o.id[i] = Number(t.id.slice(1));
    o.kind[i] = of(kinds, kindNames, t.kind);
    o.species[i] = of(species, speciesNames, t.kind === "item" ? t.item ?? "" : t.kind === "structure" ? t.shelter?.style ?? "" : t.species ?? "");
    o.px[i] = t.px; o.py[i] = t.py; o.size[i] = t.size; o.seed[i] = t.seed;
  }
  return o;
}
