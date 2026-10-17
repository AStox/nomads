// Where every thing is: by id, by kind and tile, and which ones the world has to keep looking at. Every lookup that
// asks what lies near a point goes through here, so dense ground never costs a scan of the whole island.
//
// What the ground grew (trees, grass, rocks and the rest, millions of them) lives on the GPU as the flora's objects
// (src/gpu/flora.ts), object number e being thing t{e}, and becomes Things only where something first looks at its
// tile. Then the tile is stocked: each object standing there becomes a Thing like any other, read as the flora answers
// for it (as the GPU held it after its stems last grew, with the changes made since). Once a day the stems grow, crowd
// and starve on the GPU, and the stocked tiles' trees and bushes take their new heights or go (grownOn). A stocked tile
// no one has looked at for a day, far from everyone, whose grown things all stand as the GPU has them, is put back:
// its Things go, to be made the same way, with the same ids, the next time anything looks. What anyone made, dropped
// or changed stays. A grown Thing's kind, species, size or place changed, or the Thing gone, goes to its object at once
// (leave, setKind, and wake, which every change calls through mark).
//
// Sticks, fallen logs, boulders, stones and pebbles are pieces on the GPU (src/gpu/deadwood.ts), far too many to stock
// as Things: one becomes a Thing (a view, named by its piece's id) only when a lookup asks for its kind where it lies
// (around, nearestThing, thingById); a lookup of every kind (kinds null) makes views of the fallen logs only. A view no
// one has changed goes again once it has rotted away, or nothing has looked at its tile for a day and no one is near
// (shelve). One changed is touched: its piece goes active with it, and one taken is gone for good.
import { DAY, H, HP, TILE_M, W, cropOf, groundOf, grown, heldStore, ringOf, storeOf, type Thing, type World } from "./world";
import { FLORA, SPECIES, clasts } from "../terrain/flora";
import { Flora, type Stand, type StemDriver } from "../gpu/flora";
import { theGpu } from "../gpu/device";
import { BOULDERS_HA, CLASTS, CLAST_DIM, Deadwood, capacities, type Piece, type PieceKind } from "../gpu/deadwood";
import { Seedlings, type SeedDriver } from "../gpu/seedlings";
import { Crowns } from "../gpu/crowns";
import { Moisture } from "../gpu/moisture";
import { Fire } from "../gpu/fire";
import { moistureDriver } from "./wetness";
import { Smalls } from "../gpu/smalls";
import { smallsDriver } from "./smalls";
import { CELL_MM } from "../gpu/wgsl/index";
import { N } from "../terrain/grid";

type Index = {
  at: Map<string, number>; tiles: Map<string, (Thing[] | undefined)[]>; live: Set<Thing>;
  stocked: Uint8Array; // 1 where the tile's grown things are Things in w.things
  seen: Int32Array; // the tick something last looked at each tile
  changes: Uint32Array; // how many times anything has come onto each tile's bins or left them
  taken: Map<string, number>; // grown things gone from a stocked tile, and the tick they went
  flora: Flora; // what the ground grew, as its objects stand
  dead: Deadwood | null; // the deadwood and clasts, once resident
  seeds: Seedlings | null; // the seeds and seedlings, once resident
  crowns: Crowns | null; // the crown raster, once resident
  moist: Moisture | null; // the water of what lies out, once resident
  fire: Fire | null; // the beds burning, and what lies near them taking their heat, once resident
  smalls: Smalls; // grass tillers, fine litter, invertebrates and soil fauna, moved sand (lumped), resident with the flora
  views: Set<string>; // pieces made Things that no one has changed
  landings: number; // the flora's landings of its stems the Things have taken up
};
const indexes = new WeakMap<World, Index>();

// Plants and stones as the ground laid them out need nothing from the world until someone or something touches them; one
// burning, or still warm from a fire near it, stays in the world's eye until it has cooled (ecology.ts fire).
const STILL: Record<string, true> = { tree: true, bush: true, boulder: true, stone: true, pebble: true, stick: true, fallen_log: true, mushroom: true, herb: true, reeds: true, fern: true, flowers: true, grass: true, clay: true };
const settled = (t: Thing) =>
  STILL[t.kind] && !t.bed && !t.absorbed && !t.scarred && !t.owner && (t.hp ?? 0) >= (t.maxHp ?? 0) && !(t.kind === "bush" && t.species === "berry" && (t.n ?? 0) < cropOf(t));

function bucket(ix: Index, t: Thing) {
  let tiles = ix.tiles.get(t.kind);
  if (!tiles) ix.tiles.set(t.kind, (tiles = new Array(W * H)));
  (tiles[t.y * W + t.x] ??= []).push(t);
  ix.changes[t.y * W + t.x]++;
}
function unbucket(ix: Index, t: Thing) {
  const b = ix.tiles.get(t.kind)?.[t.y * W + t.x];
  const i = b ? b.indexOf(t) : -1;
  if (i < 0) return;
  b![i] = b![b!.length - 1];
  b!.pop();
  ix.changes[t.y * W + t.x]++;
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
  const flora = new Flora(groundOf(w.seed).flora);
  ix = { at: new Map(), tiles: new Map(), live: new Set(), stocked: new Uint8Array(W * H), seen: new Int32Array(W * H), changes: new Uint32Array(W * H), taken: new Map(), flora, landings: flora.landings, dead: null, seeds: null, crowns: null, moist: null, fire: null, smalls: new Smalls(), views: new Set() };
  // every kind the ground grows has its bins from the start, so stocking a tile mid-search never adds a list to search
  for (const k of FLORA) ix.tiles.set(k, new Array(W * H));
  for (const t of w.stocked) ix.stocked[t] = 1;
  for (let i = 0; i < w.things.length; i++) {
    const t = w.things[i];
    ix.at.set(t.id, i);
    bucket(ix, t);
    if (!settled(t)) ix.live.add(t);
    else if (PIECE_ID.test(t.id)) ix.views.add(t.id);
  }
  // the changes the world holds (a world loaded from its JSON): every object on a stocked tile as its Thing stands, or
  // gone with it; a tile not stocked holds nothing but as it grew
  const start = flora.f.start;
  for (const t of w.stocked)
    for (let e = start[t] + 1; e <= start[t + 1]; e++) {
      const i = ix.at.get(`t${e}`);
      flora.change(e, i === undefined ? null : standOf(w.things[i]));
    }
  indexes.set(w, ix);
  return ix;
}
// The world's flora: what the ground grew, as its objects stand.
export const floraOf = (w: World) => index(w).flora;
// The world's flora takes up residence on the GPU, the first time the world runs (sim.ts tick), on the store the world
// has (one loaded with a save) or a new one, its stems growing by the world's own ground (plants.ts stemDriver), and its
// seeds and seedlings after them (seeds.ts seedDriver).
export async function resident(w: World, stems: StemDriver, seeds: SeedDriver) {
  const ix = index(w), flora = ix.flora;
  if (flora.store) return;
  const s = heldStore(w) ?? storeOf(w, await theGpu()), fresh = !s.kinds.some((k) => k.name === "log");
  flora.attach(s, stems);
  // the crowns' pass follows the stems' law each day, reading the raster it filed
  ix.crowns = new Crowns();
  await ix.crowns.attach(s, { raster: (now) => flora.raster(now) }, (t) => stems.due(t));
  const g = groundOf(w.seed), [pebble, stone, boulder] = clasts(g.isle, w.seed, BOULDERS_HA, CLAST_DIM, CLASTS.map((c) => [c.lo / 1000, c.hi / 1000] as const));
  ix.dead = new Deadwood(w.seed, { pebble, stone, boulder }, capacities(g.flora));
  ix.dead.attach(s, () => flora.raster());
  // a world whose store is new (one read from its JSON alone): the pieces its Things were made of and changed are
  // touched again, so none lies twice
  if (fresh) for (const t of w.things) if (PIECE_ID.test(t.id) && !ix.views.has(t.id)) ix.dead.touch(pieceOf(t), placeOf(t));
  ix.seeds = new Seedlings();
  ix.seeds.attach(s, flora, seeds);
  // what lies out holds its own water, stepped each hour in the island's weather (wetness.ts)
  ix.moist = new Moisture();
  ix.moist.attach(s, ix.crowns, ix.dead, moistureDriver(w));
  // the beds burn on the GPU, and what lies near them takes their heat and their brands there (ecology.ts fire)
  ix.fire = new Fire();
  ix.fire.attach(s);
  // the smallest things, lumped: their law each midnight after the moisture's, before the animals', who graze them; the
  // crown raster the crowns and deadwood read is let go first, so their first days borrow its memory
  flora.release();
  ix.smalls.attach(s, smallsDriver(w), ix.crowns, w.t);
}
// The world's deadwood and clasts, its seeds and seedlings, its crown raster, the water of what lies out and the fire's
// receivers, once resident.
export const deadwoodOf = (w: World) => index(w).dead;
export const seedlingsOf = (w: World) => index(w).seeds;
export const crownsOf = (w: World) => index(w).crowns;
export const moistOf = (w: World) => index(w).moist;
export const firesOf = (w: World) => index(w).fire;
export const smallsOf = (w: World) => index(w).smalls;

// ---------- pieces ----------
const PIECE_ID = /^[slbp][0-9]/;
const PIECE: Record<string, true> = { stick: true, fallen_log: true, boulder: true, stone: true, pebble: true };
const MM = TILE_M * 1000;
// A piece as the Thing that is its view stands now (its place may have changed), and where.
const pieceOf = (t: Thing): Piece => ({ kind: t.kind as PieceKind, id: t.id, x: Math.round(t.px * MM), y: Math.round(t.py * MM), size: t.size, girth: t.girth ?? t.size, species: SPECIES.indexOf((t.species ?? "") as (typeof SPECIES)[number]), seed: t.seed ?? 0 });
const placeOf = (t: Thing) => ({ x: Math.round(t.px * MM), y: Math.round(t.py * MM) });
// The view of a piece: its Thing, made now if it isn't one yet.
function viewOf(w: World, ix: Index, p: Piece): Thing {
  const i = ix.at.get(p.id);
  if (i !== undefined) return w.things[i];
  const t = grown(w, p.id, { kind: FLORA.indexOf(p.kind), species: p.species, px: p.x / MM, py: p.y / MM, size: p.size, seed: p.seed });
  if (p.kind === "stick" || p.kind === "fallen_log") t.girth = p.girth;
  add(w, ix, t, false);
  ix.views.add(p.id);
  return t;
}
// The pieces of a kind lying in a box of mm, as the cells' last landing has them (a cell not landed yet holds none
// this tick and is asked for).
function piecesIn(ix: Index, kind: PieceKind, x0: number, y0: number, x1: number, y1: number): Piece[] {
  const d = ix.dead!, out: Piece[] = [], cx0 = Math.max(0, Math.floor(x0 / CELL_MM)), cx1 = Math.min(N - 1, Math.floor(x1 / CELL_MM));
  const cy0 = Math.max(0, Math.floor(y0 / CELL_MM)), cy1 = Math.min(N - 1, Math.floor(y1 / CELL_MM));
  for (let cy = cy0; cy <= cy1; cy++)
    for (let cx = cx0; cx <= cx1; cx++) {
      const c = cy * N + cx, list = kind === "stick" ? d.sticksIn(c, x0, y0, x1, y1) : kind === "fallen_log" ? d.logsIn(c) : d.clastsIn(kind, c, x0, y0, x1, y1);
      if (typeof list === "symbol") continue;
      for (const p of list) if (p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1) out.push(p);
    }
  return out;
}
// How many pieces of a kind lie within r m of a point as they were laid or fell (their views among them; one touched is
// a thing of its own), and how far off the nearest is (null for none), without making views of them.
export function piecesAround(w: World, px: number, py: number, r: number, kind: PieceKind): { count: number; nearest: number } | null {
  const ix = index(w);
  if (!ix.dead) return null;
  const x = px * MM, y = py * MM, rm = r * 1000;
  let count = 0, nearest = Infinity;
  if (kind !== "stick" && kind !== "fallen_log") {
    const cx0 = Math.max(0, Math.floor((x - rm) / CELL_MM)), cx1 = Math.min(N - 1, Math.floor((x + rm) / CELL_MM));
    const cy0 = Math.max(0, Math.floor((y - rm) / CELL_MM)), cy1 = Math.min(N - 1, Math.floor((y + rm) / CELL_MM));
    for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) {
      const n = ix.dead.clastsAround(kind, cy * N + cx, x, y, rm);
      count += n.count; nearest = Math.min(nearest, n.nearest / 1000);
    }
    return count > 0 ? { count, nearest } : null;
  }
  for (const p of piecesIn(ix, kind, x - rm, y - rm, x + rm, y + rm)) {
    const d = Math.hypot(p.x - x, p.y - y);
    if (d <= rm) { count++; nearest = Math.min(nearest, d / 1000); }
  }
  return count ? { count, nearest } : null;
}
// Views made of every piece of these kinds within r m of a point (of the fallen logs only, for every kind).
function materialize(w: World, ix: Index, px: number, py: number, r: number, kinds: readonly string[] | null) {
  if (!ix.dead) return;
  const x = px * MM, y = py * MM, rm = r * 1000;
  for (const k of kinds ?? ["fallen_log"]) {
    if (!PIECE[k]) continue;
    for (const p of piecesIn(ix, k as PieceKind, x - rm, y - rm, x + rm, y + rm)) if (!ix.at.has(p.id) && Math.hypot(p.x - x, p.y - y) <= rm) viewOf(w, ix, p);
  }
}
// The stems as the GPU last grew them: once a landing has brought them back, the trees and bushes on every stocked tile,
// and those people raised wherever they stand (makeStem), take the heights they grew to, their hit points growing as
// much, and those the GPU starved or crowded out go: a dead tree stands on as a snag on the GPU and falls as a log
// (src/gpu/deadwood.ts) [gap: a snag isn't yet a Thing].
export function grownOn(w: World) {
  const ix = index(w), flora = ix.flora, start = flora.f.start;
  if (ix.landings === flora.landings) return;
  ix.landings = flora.landings;
  for (const t of w.stocked)
    for (let e = start[t] + 1; e <= start[t + 1]; e++) {
      if (!flora.isPlant(e)) continue;
      const i = ix.at.get(`t${e}`);
      if (i === undefined) continue;
      const th = w.things[i], s = flora.stand(e);
      // one turned into something else (a stump, a dead bush) is no longer a stem
      if (th.kind !== FLORA[flora.f.kind[e - 1]]) continue;
      if (!s) { drop(w, ix, th); continue; }
      if (th.size === s.size) continue;
      const hp = HP[th.kind](s.size);
      th.hp = Math.max(1, (th.hp ?? hp) + hp - (th.maxHp ?? hp));
      th.maxHp = hp;
      th.size = s.size;
      ix.changes[th.y * W + th.x]++;
    }
  for (const id of flora.madeIds()) {
    const i = ix.at.get(id), s = flora.madeStand(id);
    if (i === undefined) continue;
    const th = w.things[i];
    if (!s) { flora.unmake(id); drop(w, ix, th); continue; }
    if (th.size === s.size) continue;
    const hp = HP[th.kind](s.size);
    th.hp = Math.max(1, (th.hp ?? hp) + hp - (th.maxHp ?? hp));
    th.maxHp = hp;
    th.size = s.size;
    ix.changes[th.y * W + th.x]++;
  }
}
// A tree or bush people raised (ecology.ts matured) stands from now on as a stem on the GPU, which grows it and may
// starve or crowd it out as it does the ground's own (gpu/flora.ts make).
export function makeStem(w: World, t: Thing) {
  const s = standOf(t);
  if (s) index(w).flora.make(t.id, s);
}

// A grown thing as its object stands: null once it is no longer something the ground grows or lays (a felled tree's
// stump, a bramble picked to death).
function standOf(t: Thing): Stand | null {
  const kind = FLORA.indexOf(t.kind as (typeof FLORA)[number]), species = SPECIES.indexOf((t.species ?? "") as (typeof SPECIES)[number]);
  if (kind < 0) return null;
  if (species < 0) throw new Error(`${t.id}, a ${t.kind}, is of a species (${t.species}) nothing grows`);
  return { kind, species, px: t.px, py: t.py, size: t.size, seed: t.seed };
}
// Something looks at tile t: its grown things become Things, if they aren't yet.
function stock(w: World, ix: Index, t: number) {
  ix.seen[t] = w.t;
  if (ix.stocked[t]) return;
  ix.stocked[t] = 1;
  w.stocked.push(t);
  const flora = ix.flora, start = flora.f.start;
  for (let e = start[t] + 1; e <= start[t + 1]; e++) {
    const s = flora.stand(e);
    if (!s) continue;
    const th = grown(w, e, s);
    add(w, ix, th, !settled(th));
  }
}
// The things of a kind on tile i as it stands, without looking at it (it stays as it grew if no one has).
export const onTile = (w: World, i: number, kind: string): readonly Thing[] => index(w).tiles.get(kind)?.[i] ?? [];
// Whether tile i has been looked at since it was last put back as it grew.
export const stockedTile = (w: World, i: number) => index(w).stocked[i] === 1;
// Whether the tile a point is on has been looked at since it was last put back as it grew: its grown things are Things.
export const stockedAt = (w: World, px: number, py: number) => index(w).stocked[Math.min(H - 1, Math.floor(py)) * W + Math.min(W - 1, Math.floor(px))] === 1;
// The object number of what the ground grew that a thing id names, or 0 if it names something made since.
function grownNumber(ix: Index, id: string) {
  const e = Number(id.slice(1));
  return id[0] === "t" && Number.isInteger(e) && e >= 1 && e <= ix.flora.n ? e : 0;
}

// A new thing enters the world. Things made after the ground was laid out are live from the start.
export function enter(w: World, t: Thing, live: boolean) {
  add(w, index(w), t, live);
}
// A thing goes from w.things, as a thing taken does and as a grown thing put back does (whose object stays).
function drop(w: World, ix: Index, t: Thing) {
  const i = ix.at.get(t.id);
  // one already gone leaves nothing behind, though a thing with its id may have come since (its tile stocked again)
  if (i === undefined || w.things[i] !== t) return false;
  const last = w.things.pop()!;
  if (last !== t) { w.things[i] = last; ix.at.set(last.id, i); }
  ix.at.delete(t.id);
  unbucket(ix, t);
  ix.live.delete(t);
  return true;
}
export function leave(w: World, t: Thing) {
  const ix = index(w);
  if (!drop(w, ix, t)) return;
  if (ix.dead && PIECE_ID.test(t.id)) { ix.views.delete(t.id); ix.dead.touch(pieceOf(t), null); return; }
  const e = grownNumber(ix, t.id);
  if (e) { ix.taken.set(t.id, w.t); ix.flora.change(e, null); }
  else ix.flora.unmake(t.id);
}
export const thingById = (w: World, id?: string | null) => {
  if (!id) return undefined;
  const ix = index(w);
  let i = ix.at.get(id);
  if (i === undefined) {
    // a grown thing on a tile nothing has looked at yet is still there as it stands
    if (ix.dead && PIECE_ID.test(id)) {
      const p = ix.dead.piece(id);
      return p && typeof p === "object" ? viewOf(w, ix, p) : undefined;
    }
    const e = grownNumber(ix, id), t = e ? ix.flora.tileOf(e) : -1;
    if (t < 0 || ix.stocked[t]) return undefined;
    stock(w, ix, t);
    i = ix.at.get(id);
    if (i === undefined) return undefined;
  }
  return w.things[i];
};
// A grown thing in the world changed: its object stands as it does now.
function changed(ix: Index, t: Thing) {
  if (ix.dead && PIECE_ID.test(t.id)) { ix.views.delete(t.id); ix.dead.touch(pieceOf(t), placeOf(t)); return; }
  const e = grownNumber(ix, t.id);
  if (e) ix.flora.change(e, standOf(t));
  // a stem people raised that is no longer a tree or bush (felled, burned) is gone from the GPU
  else if (t.kind !== "tree" && t.kind !== "bush") ix.flora.unmake(t.id);
}
// Something happened to it: it changed kind, burned, got hurt, was picked. The world keeps an eye on it from now on, while
// it is in the world: what the world keeps an eye on is always in it (ecology.ts relies on that).
export const wake = (w: World, t: Thing) => {
  if (!exists(w, t)) return;
  const ix = index(w);
  ix.live.add(t);
  changed(ix, t);
};
export const exists = (w: World, t: Thing) => { const i = index(w).at.get(t.id); return i !== undefined && w.things[i] === t; };
export const liveThings = (w: World) => index(w).live;
export function setKind(w: World, t: Thing, kind: Thing["kind"]) {
  const ix = index(w), here = exists(w, t);
  if (here) unbucket(ix, t);
  t.kind = kind;
  if (here) { bucket(ix, t); ix.live.add(t); changed(ix, t); }
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

// A hair over a distance in tiles, so a thing turned away for lying further off than that along either axis is truly out of
// reach, whatever the rounding (around, nearestThing).
const SLACK = 1 + 1e-9;
// The bins by tile of these kinds that anything has ever been put in (of every kind, for null).
function binsOf(ix: Index, kinds: readonly string[] | null) {
  if (!kinds) return [...ix.tiles.values()];
  const out: (Thing[] | undefined)[][] = [];
  for (const k of kinds) { const l = ix.tiles.get(k); if (l) out.push(l); }
  return out;
}
// Every thing of these kinds within r meters of a point, nearest tiles first. fn returns true to stop.
export function around(w: World, px: number, py: number, r: number, kinds: readonly string[] | null, fn: (t: Thing, d: number) => boolean | void) {
  const ix = index(w), rt = r / TILE_M, lim = rt * SLACK;
  const x0 = Math.max(0, Math.floor(px - rt)), x1 = Math.min(W - 1, Math.floor(px + rt));
  const y0 = Math.max(0, Math.floor(py - rt)), y1 = Math.min(H - 1, Math.floor(py + rt));
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) stock(w, ix, y * W + x);
  materialize(w, ix, px, py, r, kinds);
  const lists = binsOf(ix, kinds);
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++)
      for (const tiles of lists) {
        const b = tiles[y * W + x];
        if (!b) continue;
        for (const t of b) {
          const dx = t.px - px, dy = t.py - py;
          if (dx > lim || dx < -lim || dy > lim || dy < -lim) continue;
          const d = Math.hypot(dx, dy) * TILE_M;
          if (d <= r && fn(t, d)) return;
        }
      }
}
// Every tile within r meters of a point looked at, as around looks at them, and a count that moves whenever anything
// comes onto one of them, leaves it or changes kind there: what's worked out from what stands round a point holds until
// the count moves.
export function lookAround(w: World, px: number, py: number, r: number) {
  const ix = index(w), rt = r / TILE_M;
  const x0 = Math.max(0, Math.floor(px - rt)), x1 = Math.min(W - 1, Math.floor(px + rt));
  const y0 = Math.max(0, Math.floor(py - rt)), y1 = Math.min(H - 1, Math.floor(py + rt));
  let n = 0;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { stock(w, ix, y * W + x); n += ix.changes[y * W + x]; }
  return n;
}
export function anyAround(w: World, px: number, py: number, r: number, kinds: readonly string[] | null, ok: (t: Thing) => boolean = () => true) {
  let hit: Thing | null = null;
  around(w, px, py, r, kinds, (t) => { if (ok(t)) { hit = t; return true; } });
  return hit as Thing | null;
}
// How far a point lies from tile i, in meters (0 on it).
const fromTile = (i: number, px: number, py: number) => {
  const x = i % W, y = (i - x) / W;
  return Math.hypot(Math.max(x - px, 0, px - x - 1), Math.max(y - py, 0, py - y - 1)) * TILE_M;
};
// The nearest thing of these kinds that passes ok, searching outward ring by ring of tiles, out to max meters. A tile
// that lies wholly farther off than the nearest found so far can't hold anything nearer, and isn't looked at.
export function nearestThing(w: World, px: number, py: number, kinds: readonly string[], ok: (t: Thing) => boolean = () => true, max = Infinity): Thing | null {
  const ix = index(w), lists = binsOf(ix, kinds);
  if (!lists.length) return null;
  let best: Thing | null = null, bd = max, lim = (bd / TILE_M) * SLACK;
  for (let R = 0; R < Math.max(W, H) && (R - 1) * TILE_M <= bd; R++)
    for (const i of ringOf(Math.floor(px), Math.floor(py), R)) {
      if (fromTile(i, px, py) > bd * SLACK) continue;
      stock(w, ix, i);
      for (const tiles of lists) {
        const b = tiles[i];
        if (!b) continue;
        for (const t of b) {
          const dx = t.px - px, dy = t.py - py;
          if (dx > lim || dx < -lim || dy > lim || dy < -lim) continue;
          const d = Math.hypot(dx, dy) * TILE_M;
          if (d < bd && ok(t)) { bd = d; best = t; lim = (bd / TILE_M) * SLACK; }
        }
      }
    }
  // pieces lying nearer than that: looked for in boxes doubling from 4 m, each found made a view and tried in turn
  const want = ix.dead ? kinds.filter((k) => PIECE[k]) : [];
  if (!want.length) return best;
  const x = px * MM, y = py * MM;
  let tries = 0;
  for (let r = 4; r < 2 * Math.min(bd, max, 2048) && tries < 32; r *= 2) {
    const R = Math.min(r, bd, max), rm = R * 1000, found: [number, Piece][] = [];
    for (const k of want) for (const p of piecesIn(ix, k as PieceKind, x - rm, y - rm, x + rm, y + rm)) {
      const d = Math.hypot(p.x - x, p.y - y) / 1000;
      if (d <= R && d < bd && !ix.at.has(p.id)) found.push([d, p]);
    }
    found.sort((a, b) => a[0] - b[0] || (a[1].id < b[1].id ? -1 : 1));
    for (const [d, p] of found) {
      if (tries++ >= 32) break;
      const t = viewOf(w, ix, p);
      if (ok(t)) { best = t; bd = d; break; }
    }
    if (best && bd <= R) break;
  }
  return best;
}
// Looking out to max meters for things of these kinds when none could pass (grain out of season, say): nothing is found,
// and every tile nearestThing would have looked at is looked at all the same.
export function lookFor(w: World, px: number, py: number, kinds: readonly string[], max: number) {
  const ix = index(w);
  if (!binsOf(ix, kinds).length) return;
  for (let R = 0; R < Math.max(W, H) && (R - 1) * TILE_M <= max; R++)
    for (const i of ringOf(Math.floor(px), Math.floor(py), R)) if (fromTile(i, px, py) <= max * SLACK) stock(w, ix, i);
}
// A thing of this kind picked at random over the island, or null when there are none, by the caller's own seeded stream
// (no default: an unseeded draw would make the run unrepeatable).
export function anyOf(w: World, kind: string, rand: () => number): Thing | null {
  const code = FLORA.indexOf(kind as (typeof FLORA)[number]), list = code < 0 ? new Uint32Array(0) : index(w).flora.writtenOf(code);
  for (let tries = 0; tries < 16 && list.length; tries++) {
    const t = thingById(w, `t${list[Math.floor(rand() * list.length)]}`);
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
  // as many fields set on each, and every one set on a the same on b
  let n = 0;
  for (const k in x) {
    const u = x[k], v = y[k];
    if (u === undefined) continue;
    n++;
    if (u === v) continue;
    if (!u || !v || typeof u !== "object" || typeof v !== "object" || JSON.stringify(u) !== JSON.stringify(v)) return false;
  }
  for (const k in y) if (y[k] !== undefined) n--;
  return n === 0;
}
// Once a day: put back every stocked tile nothing has looked at for a day, with no one within a kilometer, whose grown
// things all stand exactly as the GPU last had them (those it killed gone). Their Things go; their objects stay.
export function shelve(w: World) {
  const ix = index(w), flora = ix.flora, start = flora.f.start, near = 1000 / TILE_M, kept: number[] = [];
  for (const t of w.stocked) {
    const x = t % W + 0.5, y = Math.floor(t / W) + 0.5;
    let asGrown = w.t - ix.seen[t] >= DAY && !w.agents.some((a) => Math.abs(a.px - x) < near && Math.abs(a.py - y) < near);
    for (let e = start[t] + 1; asGrown && e <= start[t + 1]; e++) {
      const i = ix.at.get(`t${e}`), s = flora.grownStand(e);
      asGrown = s ? i !== undefined && same(w.things[i], grown(w, e, s)) : i === undefined;
    }
    if (!asGrown) { kept.push(t); continue; }
    for (let e = start[t] + 1; e <= start[t + 1]; e++) {
      const i = ix.at.get(`t${e}`);
      if (i !== undefined) drop(w, ix, w.things[i]);
      ix.taken.delete(`t${e}`);
    }
    ix.stocked[t] = 0;
  }
  w.stocked = kept;
  // the views no one has changed: gone once their pieces have rotted away, or put back where nothing has looked for a
  // day and no one is near
  for (const id of [...ix.views]) {
    const i = ix.at.get(id);
    if (i === undefined) { ix.views.delete(id); continue; }
    const t = w.things[i], far = !w.agents.some((a) => Math.abs(a.px - t.px) < near && Math.abs(a.py - t.py) < near);
    if (ix.dead?.piece(id) === null || (far && w.t - ix.seen[t.y * W + t.x] >= DAY)) { drop(w, ix, t); ix.views.delete(id); }
  }
}

// What was taken of the ground's own growth comes back where it grew: back: given one as it grew and the tick it went
// (that of the world's loading, for one gone before), whether it's back now (ecology.ts regrowth). Its object is as the
// generator wrote it again (the taken-tick rule; later units make regrowth the kinds' own processes). Trees and bushes
// never come back where they stood.
export function regrow(w: World, back: (t: Thing, went: number) => boolean) {
  const ix = index(w), flora = ix.flora, start = flora.f.start;
  for (const t of w.stocked)
    for (let e = start[t] + 1; e <= start[t + 1]; e++) {
      const id = `t${e}`;
      if (ix.at.has(id) || flora.isPlant(e)) continue;
      const as = flora.written(e), th = grown(w, e, as);
      if (!back(th, ix.taken.get(id) ?? (ix.taken.set(id, w.t), w.t))) continue;
      ix.taken.delete(id);
      flora.change(e, as);
      add(w, ix, th, !settled(th));
    }
}
