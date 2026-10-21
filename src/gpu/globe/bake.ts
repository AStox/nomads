// A planet as the play page reads it: the fields windowOf takes, at float32, so that a window the page makes is the one Bun
// makes at the same place, and the globe viewer's fields, quantised to what a picture needs (VIEW_SCALES).
import { LAPSE } from "../../terrain/climate";
import { DOLERITE, GRANITE, LIMESTONE, MUDSTONE, SANDSTONE } from "../../terrain/geology";
import { SEASON_S } from "./atmosphere";
import { RADIUS_M, tierGrid } from "./grid";
import { SEASON_COUNT, landingsOf, packRecord, rockAtDepth, unpackRecord, upstreamOf, type Landing, type Planet } from "./window";

// ---------- the planet for windowOf ----------
const seasonKeys = ["t", "rain", "runoff", "windE", "windN", "sst"] as const;
export function planetBytes(p: Planet): Uint8Array {
  const arrays: Record<string, Float32Array | Uint32Array> = { height: p.height, to: p.to, acc: p.acc, iceMax: p.ice.maxM, iceNow: p.ice.nowM, iceLaid: p.ice.laidM };
  p.pools.forEach((a, k) => (arrays[`pool${k}`] = a));
  p.seasons.forEach((s, k) => { for (const f of seasonKeys) arrays[`${f}${k}`] = s[f]; });
  return packRecord({ seed: p.seed, n: p.n, sea: p.sea, radius: p.radius }, arrays);
}
// The season's snow and the ice's cut rock are not carried (windowOf and landingsOf read neither): they come back empty.
export function planetFromBytes(bytes: Uint8Array): Planet {
  const { meta, arrays: a } = unpackRecord(bytes), f = (k: string) => a[k] as Float32Array, none = new Float32Array(0);
  return {
    seed: meta.seed, n: meta.n, height: f("height"), to: a.to as Uint32Array, acc: a.acc as Uint32Array,
    pools: [0, 1, 2, 3, 4].map((k) => f(`pool${k}`)),
    seasons: Array.from({ length: SEASON_COUNT }, (_, k) => ({ t: f(`t${k}`), rain: f(`rain${k}`), snow: none, runoff: f(`runoff${k}`), windE: f(`windE${k}`), windN: f(`windN${k}`), sst: f(`sst${k}`) })),
    ice: { maxM: f("iceMax"), nowM: f("iceNow"), cutM: none, laidM: f("iceLaid") },
    sea: meta.sea, radius: meta.radius ?? RADIUS_M,
  };
}

// ---------- the viewer's fields ----------
// Each field is stored as an integer of the width given, the value being the integer times `step` (river: 2^(q/16) - 1).
export const VIEW_SCALES = {
  height: { type: "Int16", step: 1, unit: "m above the present sea" },
  temp: { type: "Int8", step: 0.5, unit: "C, the year's mean air at the ground (sea-level air less the lapse rate over land)" },
  rain: { type: "Uint16", step: 1, unit: "mm of water a year" },
  ice: { type: "Uint16", step: 1, unit: "m of ice standing now" },
  rock: { type: "Uint8", step: 1, unit: "the island's rock class at the surface (terrain/geology.ts)" },
  river: { type: "Uint8", step: 1, unit: "q = 16 log2(1 + Q), Q the year's mean discharge in m3/s down the planet's receivers in the present climate" },
} as const;
// The rivers drawn as segments from a land cell to its receiver: those carrying at least this much [design: a picture's cut].
export const RIVER_SEGMENT_M3S = 20;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(v)));
// Typed arrays of 1 and 2 bytes travel in the record's 4-byte words (393,216 cells a field is a multiple of 4).
const words = (a: Int8Array | Uint8Array | Int16Array | Uint16Array) => new Uint32Array(a.buffer, a.byteOffset, a.byteLength / 4);

export function viewBytes(p: Planet, key: string): Uint8Array {
  const n = p.n, height = new Int16Array(n), temp = new Int8Array(n), rain = new Uint16Array(n), ice = new Uint16Array(n), rock = new Uint8Array(n), river = new Uint8Array(n);
  const q = upstreamOf(p), year = SEASON_COUNT * SEASON_S, segs: number[] = [];
  for (let i = 0; i < n; i++) {
    const h = p.height[i];
    let t = 0, r = 0, ro = 0;
    for (let k = 0; k < SEASON_COUNT; k++) { t += p.seasons[k].t[i] / SEASON_COUNT; r += p.seasons[k].rain[i]; ro += q.runoff[k][i]; }
    height[i] = clamp(h, -32768, 32767);
    temp[i] = clamp((t - LAPSE * Math.max(0, h)) / VIEW_SCALES.temp.step, -128, 127);
    rain[i] = clamp(r, 0, 65535);
    ice[i] = clamp(p.ice.nowM[i], 0, 65535);
    rock[i] = rockAtDepth(p.pools.map((a) => a[i]), 0);
    const m3s = h > 0 ? ro / year : 0;
    river[i] = clamp(16 * Math.log2(1 + m3s), 0, 255);
    if (m3s >= RIVER_SEGMENT_M3S && p.to[i] !== i) segs.push(i, p.to[i]);
  }
  const landings = landingsOf(p, 20).map(({ cell: _, ...l }) => l);
  const rocks = { [MUDSTONE]: "mudstone", [SANDSTONE]: "sandstone", [LIMESTONE]: "limestone", [GRANITE]: "granite", [DOLERITE]: "dolerite" };
  const meta = { seed: p.seed, key, n, fn: tierGrid(0).fn, radius: p.radius, sea: p.sea, scales: VIEW_SCALES, landings, rocks };
  return packRecord(meta, { height: words(height), temp: words(temp), rain: words(rain), ice: words(ice), rock: words(rock), river: words(river), segments: Uint32Array.from(segs) });
}
export interface View {
  meta: { seed: number; key: string; n: number; fn: number; sea: Planet["sea"]; landings: Omit<Landing, "cell">[]; rocks: Record<number, string> };
  height: Int16Array; temp: Int8Array; rain: Uint16Array; ice: Uint16Array; rock: Uint8Array; river: Uint8Array; segments: Uint32Array;
}
export function viewFromBytes(bytes: Uint8Array): View {
  const { meta, arrays: a } = unpackRecord(bytes), b = (k: string) => a[k].buffer;
  return {
    meta: meta as View["meta"],
    height: new Int16Array(b("height")), temp: new Int8Array(b("temp")), rain: new Uint16Array(b("rain")), ice: new Uint16Array(b("ice")),
    rock: new Uint8Array(b("rock")), river: new Uint8Array(b("river")), segments: a.segments as Uint32Array,
  };
}

// ---------- the 75 m pyramid ----------
// The planet at its 75 m tier (docs/research/globe/2026-10-21-planet-75m-impl.md), baked for the page to stream as tiles. A tier t holds 6 * 4^t tiles of 256 by 256 cells (tier 4: 1,536
// tiles of 75 m cells, 2,046 over tiers 0 to 4); tier t - 1's cell is the 2 by 2 of tier t's (a box mean, or for a class the commonest and for a river the greatest). One tile is
// one gzipped file, `pyramid/t<tier>/f<face>/<ty>-<tx>.tile.gz` under the planet's directory: [u32 little-endian header length][header JSON][the planes in field order, each
// 256 * 256 words of its type, little-endian, row y (north) by row, x (east) along it, the face's own axes]. The header is {version, seed, key, tier, face, tx, ty, size: 256, fields: [{name,
// type, step, unit}]}; a value is the integer times `step`. `pyramid.json` beside `t0` names the tiers, the fields and the planet's key. A tile is 1.05 MB raw (16 bytes a cell).
export const PYRAMID_VERSION = 1;
export const PYRAMID_FIELDS = [
  { name: "height", type: "i16", step: 0.25, unit: "m above the present sea; the sea floor is negative", pool: "mean" },
  { name: "rock", type: "u8", step: 1, unit: "the island's rock class at the surface (terrain/geology.ts ROCKS)", pool: "mode" },
  { name: "drift", type: "u8", step: 1, unit: "the island's drift class on it (terrain/geology.ts DRIFTS)", pool: "mode" },
  { name: "driftDepth", type: "u8", step: 0.125, unit: "m of drift, at most 30", pool: "mean" },
  { name: "temp", type: "i8", step: 0.5, unit: "C, the year's mean air at the ground", pool: "mean" },
  { name: "rain", type: "u16", step: 1, unit: "mm of rain and snow water a year", pool: "mean" },
  { name: "water", type: "u8", step: 0.5, unit: "m of standing water over the ground (a lake's depth; the sea is height under 0)", pool: "max" },
  { name: "river", type: "u8", step: 1, unit: "q = 16 log2(1 + Q), Q the year's mean discharge in m3/s", pool: "max" },
  { name: "tree", type: "u8", step: 1 / 255, unit: "share of the ground the cover takes", pool: "mean" },
  { name: "shrub", type: "u8", step: 1 / 255, unit: "share of the ground the cover takes", pool: "mean" },
  { name: "grass", type: "u8", step: 1 / 255, unit: "share of the ground the cover takes", pool: "mean" },
  { name: "marsh", type: "u8", step: 1 / 255, unit: "share of the ground the cover takes", pool: "mean" },
  { name: "bare", type: "u8", step: 1 / 255, unit: "share of the ground the cover takes", pool: "mean" },
  { name: "soil", type: "u8", step: 0.025, unit: "m of soil over the rock, at most 6.4", pool: "mean" },
] as const;
export type PyramidField = (typeof PYRAMID_FIELDS)[number];

// ---------- the ground tiles ----------
// Beside the pyramid, at tier 4 only, one file a tile of every field the scatter (scatter.ts) and the close levels' painter (demo/styles/isopixel/ground.wgsl.js packGround) read, each in the
// stage file's own words (nothing is converted but `dir`), in a field of the tile's 256 by 256 cells and a halo of 8 all round it (the rivers' reach; the scatter reads its 2 from it): side 272.
// Path `groundtiles/f<face>/<ty>-<tx>.gt.gz` under the planet's directory. [u32 little-endian header length][header JSON][the planes in GROUNDTILE_FIELDS order, each 272 * 272 words of its
// type, little-endian, row y (north) by row, x (east) along it, the face's own axes, the cells past a face's edge being the face across's, laid flat as patch.ts lays them; at a cube's
// corner the missing cells repeat the nearest and have no channel]. The header is {version, seed, key, tile (face * 256 + ty * 16 + tx), face, tx, ty, halo: 8, side: 272, fields: [{name, type, step,
// unit}] (only the planes the file holds, in order: a stage whose file did not exist is a gap, not a zero plane), quick: [4] | null (the water stage's per-tile quick runoff by season)}.
// `dir` is the receiver of the cell: 0 none (a sea or outlet cell, or a receiver outside the field), 1 to 8 the neighbour at (dx, dy) = DIRS[dir - 1] in cell steps (x east, y north in the plane).
export const GROUNDTILE_VERSION = 1, GROUNDTILE_HALO = 8, GROUNDTILE_SIDE = 256 + 2 * GROUNDTILE_HALO;
export const DIRS: readonly (readonly [number, number])[] = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
const season = (stem: string, file: string, type: "u16" | "i16" | "u8", step: number, unit: string) => [0, 1, 2, 3].map((k) => ({ name: `${stem}${k}`, type, step, unit: `${unit}, season ${k}`, file: `t4-${file}${k}.${type}` }));
export const GROUNDTILE_FIELDS = [
  { name: "height", type: "i32", step: 1 / 256, unit: "m above the present sea", file: "t4-height.i32" },
  { name: "water", type: "u16", step: 0.01, unit: "m of standing water over the ground (the sea's depth, a lake's)", file: "t4-water.u16" },
  { name: "rock", type: "u8", step: 1, unit: "geology.ts ROCKS class at the surface", file: "t4-rock.u8" },
  { name: "moist", type: "u8", step: 1 / 255, unit: "the water the roots find through the growing season, 0 to 1", file: "t4-moist.u8" },
  { name: "tree", type: "u8", step: 1 / 255, unit: "cover share", file: "t4-tree.u8" },
  { name: "shrub", type: "u8", step: 1 / 255, unit: "cover share", file: "t4-shr.u8" },
  { name: "grass", type: "u8", step: 1 / 255, unit: "cover share", file: "t4-grs.u8" },
  { name: "marsh", type: "u8", step: 1 / 255, unit: "cover share", file: "t4-mar.u8" },
  { name: "bare", type: "u8", step: 1 / 255, unit: "cover share", file: "t4-bare.u8" },
  { name: "flags", type: "u8", step: 1, unit: "bit 0 silt (alluvium), bit 1 beach sand, bit 2 peat (depth: ground.ts PEAT_DEPTH)", file: "t4-sflag.u8" },
  { name: "soil", type: "u16", step: 1 / 1024, unit: "m of soil", file: "t4-soil.u16" },
  { name: "clayey", type: "u8", step: 1 / 255, unit: "the root zone's share of clay", file: "t4-clayey.u8" },
  { name: "ph", type: "u8", step: 1 / 30, unit: "pH", file: "t4-ph.u8" },
  { name: "winter", type: "u16", step: 1 / 256, unit: "m, the water table's depth below the ground in the middle of winter (stb3)", file: "t4-stb3.u16" },
  { name: "tab", type: "u16", step: 1 / 256, unit: "m, the year's water table's depth (the painter's table layer)", file: "t4-tab.u16" },
  ...season("sun", "sun", "u16", 1 / 1024, "MJ/m2 a day"),
  ...season("tmp", "tmp", "i16", 1 / 256, "C"),
  ...season("sw", "sw", "u8", 1 / 255, "how full the root zone is at the season's end"),
  { name: "pr1", type: "u16", step: 1, unit: "the air stage's rain word of season 1 (the painter's precip): sqrt(mm of rain and snow water over the season) * 360, so mm = (word / 360)^2 (air.ts precipOfWord)", file: "t4-pr1.u16" },
  { name: "pe1", type: "u16", step: 0.1, unit: "mm of potential evaporation over season 1 (the painter's pet)", file: "t4-pe1.u16" },
  { name: "wsh", type: "u8", step: 1 / 255, unit: "wind share, 0 sheltered to 1 open", file: "t4-wsh.u8" },
  { name: "fog", type: "u8", step: 1 / 255, unit: "share of the year's hours inside cloud", file: "t4-fog.u8" },
  ...season("snp", "snp", "u16", 0.25, "mm of water lying as snow, the season's mean"),
  { name: "dir", type: "u8", step: 1, unit: "the receiver: 0 none, 1 to 8 the neighbour DIRS[dir - 1]", file: "t4-to.u32" },
  { name: "chn", type: "u8", step: 1, unit: "1 where a channel runs", file: "t4-chn.u8" },
  { name: "flow", type: "u32", step: 1 / 65536, unit: "m3/s, the mean flow (bankfull is water.ts BANKFULL times it)", file: "t4-flow.u32" },
  { name: "base", type: "u16", step: 1 / 65536, unit: "the groundwater's share of the flow (65535 holds 1)", file: "t4-base.u16" },
  { name: "under", type: "u16", step: 1 / 4096, unit: "m3/s, the flow the valley's fill carries under the stream's bed (held at 16)", file: "t4-under.u16" },
] as const;
export type GroundTileField = (typeof GROUNDTILE_FIELDS)[number];
export const groundTilePath = (root: string, face: number, tx: number, ty: number) => `${root}/groundtiles/f${face}/${ty}-${tx}.gt.gz`;
