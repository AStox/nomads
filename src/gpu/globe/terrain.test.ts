// The terrain stage: the till lies thick in a basement hollow and not on a ridge, clay till over soft rock is the ice's own thickness, the sea has none, a cell's answer is the same
// from two patches that overlap (no tile's edge is in it) and the same twice. Each case alone: bun test ./src/gpu/globe/terrain.test.ts -t "<name>" --timeout 280000
import { afterAll, describe, expect, test } from "bun:test";
import { releaseGpu, theGpu } from "../device";
import { BARE, GRANITE, TILL_CLAY, TILL_SAND } from "../../terrain/geology";
import { patchAt } from "./patch";
import { terrainOf, TERRAIN_HALO } from "./terrain";
import type { Planet } from "./window";

afterAll(releaseGpu);
const N0 = 6 * 256 * 256, FN = 4096, TIER = 4;
const hash = (a: ArrayBufferView) => Bun.hash(new Uint8Array(a.buffer, a.byteOffset, a.byteLength)).toString(16);
// A planet whose pool `pool` (tectonics' order: basalt, sediment, metasediment, granitoid, volcanic) is 2 km thick everywhere and the rest absent, with ice laying 12 m of till everywhere or none.
const planetOf = (pool: number, ice: boolean) => ({
  n: N0, radius: 195569.6,
  height: Float32Array.from({ length: N0 }, (_, i) => 400 + 300 * Math.sin(i * 0.0007)),
  pools: [0, 1, 2, 3, 4].map((k) => new Float32Array(N0).fill(k === pool ? 2000 : 0)),
  ice: { maxM: new Float32Array(N0).fill(ice ? 100 : 0), laidM: new Float32Array(N0).fill(ice ? 12 : 0), nowM: new Float32Array(N0), cutM: new Float32Array(0) },
}) as unknown as Planet;
// Heights (1/256 m) as a function of the cell alone: a swell with trenches 40 m deep and 4 cells wide every 100 cells along x and ridges 40 m high midway between them
const heightAt = (ids: Int32Array) => Int32Array.from(ids, (id) => {
  const cells = FN * FN, f = Math.floor(id / cells), r = id - f * cells, Y = Math.floor(r / FN), X = r - Y * FN, m = X % 100;
  return Math.round((300 + 20 * Math.sin(Y * 0.011 + f) + (m < 4 ? -40 : m >= 50 && m < 54 ? 40 : 0)) * 256);
});
// The island's blur and till law in plain integers (Q16 m): six passes of nine-cell box means with the edge repeated, then the thickness by how far the bed lies under the ground
// round it: the twin the kernel must equal word for word
const BOFF = 8192 * 65536;
function twin(h: Int32Array, side: number, tillQ: number) {
  const pass = (src: Int32Array, across: boolean) => Int32Array.from(src, (_, i) => {
    const x = i % side, y = Math.floor(i / side);
    let sum = 0;
    for (let k = -4; k <= 4; k++) sum += src[across ? y * side + Math.min(side - 1, Math.max(0, x + k)) : Math.min(side - 1, Math.max(0, y + k)) * side + x] + BOFF;
    return Math.floor((sum + 4) / 9) - BOFF;
  });
  let a = Int32Array.from(h, (v) => Math.round((v / 256) * 65536));
  const bed = a;
  for (let p = 0; p < 6; p++) a = pass(a, p % 2 === 0);
  return Int32Array.from(bed, (b, i) => {
    const d = Math.max(-16 * 65536, Math.min(16 * 65536, b - a[i])), arg = Math.max(0, Math.min(2 ** 24, 2 ** 23 - Math.trunc((d * 128) / 5)));
    return Number((BigInt(tillQ) * BigInt(arg) + 2n ** 23n) >> 24n);
  });
}

describe("the terrain stage", () => {
  test("the basement's till is the island's blur and law word for word: thick in a trench, none on a ridge; clay till is the ice's thickness; the sea has none", async () => {
    const gpu = await theGpu(), patch = patchAt(TIER, 1, 1000, 1500, TERRAIN_HALO), h = heightAt(patch.ids);
    const granite = await terrainOf({ gpu, planet: planetOf(GRANITE, false), dir: null as never, tier: TIER }, patch, h), S = patch.side, want = twin(h, S, 6 * 65536);
    let trench = 0, ridge = 0;
    for (let y = 0; y < 256; y++)
      for (let x = 0; x < 256; x++) {
        const k = (y + TERRAIN_HALO) * S + x + TERRAIN_HALO;
        expect(granite.dd[k]).toBe(want[k] >> 6);
        expect(granite.drift[k]).toBe(want[k] > 0 ? TILL_SAND : BARE);
        expect(granite.rock[k]).toBe(GRANITE);
        if (granite.dd[k] === 6 * 1024) trench++;
        if (granite.dd[k] === 0) ridge++;
      }
    expect(trench).toBeGreaterThan(256 * 6);
    expect(ridge).toBeGreaterThan(256 * 6);
    const clay = await terrainOf({ gpu, planet: planetOf(1, true), dir: null as never, tier: TIER }, patch, h);
    for (let k = 0; k < clay.dd.length; k += 41) { expect(clay.drift[k]).toBe(TILL_CLAY); expect(clay.dd[k]).toBe(12 * 1024); }
    const sea = await terrainOf({ gpu, planet: planetOf(GRANITE, false), dir: null as never, tier: TIER }, patch, h.map((v) => -v));
    for (let k = 0; k < sea.dd.length; k += 41) { expect(sea.drift[k]).toBe(0); expect(sea.dd[k]).toBe(0); }
  });

  test("a cell's drift is the same from two patches that overlap, and the same twice", async () => {
    const gpu = await theGpu(), ctx = { gpu, planet: planetOf(GRANITE, true), dir: null as never, tier: TIER };
    const a = patchAt(TIER, 2, 2000, 700, TERRAIN_HALO), b = patchAt(TIER, 2, 2128, 700, TERRAIN_HALO);
    const ra = await terrainOf(ctx, a, heightAt(a.ids)), rb = await terrainOf(ctx, b, heightAt(b.ids)), again = await terrainOf(ctx, a, heightAt(a.ids));
    const inB = new Map<number, number>();
    for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) inB.set(b.ids[(y + TERRAIN_HALO) * b.side + x + TERRAIN_HALO], (y + TERRAIN_HALO) * b.side + x + TERRAIN_HALO);
    let shared = 0;
    for (let y = 0; y < 256; y++)
      for (let x = 0; x < 256; x++) {
        const ka = (y + TERRAIN_HALO) * a.side + x + TERRAIN_HALO, kb = inB.get(a.ids[ka]);
        if (kb === undefined) continue;
        shared++;
        expect(rb.drift[kb]).toBe(ra.drift[ka]);
        expect(rb.dd[kb]).toBe(ra.dd[ka]);
        expect(rb.rock[kb]).toBe(ra.rock[ka]);
      }
    expect(shared).toBe(128 * 256);
    expect(hash(again.dd)).toBe(hash(ra.dd));
    console.log(`terrain hash ${hash(ra.dd)} ${hash(ra.drift)} ${hash(ra.rock)}`);
  });
});
