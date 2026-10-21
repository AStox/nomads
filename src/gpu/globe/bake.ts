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
