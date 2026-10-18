import { afterAll, expect, test } from "bun:test";
import { releaseGpu, theGpu } from "../gpu/device";
import { scourGpu, treeGpu, upstreamGpu, type Valley } from "../gpu/terrain/upstream";
import { ZS } from "../gpu/wgsl/terrain-upstream";
import { rng } from "../sim/world";
import { ADVERSE } from "./island";
import { TILL_MAX } from "./geology";
import { CELL, LEN, N } from "./grid";

afterAll(releaseGpu);

// The deepest closed hollow in a height field, m: how far the flooded surface stands above the ground at its worst cell.
async function deepestHollow(h: Float32Array) {
  const { filled } = await treeGpu(await theGpu(), h);
  let deepest = 0;
  for (let i = 0; i < LEN; i++) if (filled[i] >= 0) deepest = Math.max(deepest, filled[i] / ZS - h[i]);
  return deepest;
}

// A plane that rises eastward at 1%, with a 3 km joint valley along one row of it, 30 m deep, a sill in its middle.
async function valley(slope: number) {
  const bed = new Float32Array(LEN), cuttable = new Uint8Array(LEN).fill(1);
  for (let i = 0; i < LEN; i++) bed[i] = 20 + 0.01 * CELL * (i % N);
  const row = 128, line: Valley = { x: 60.5 * CELL, y: (row + 0.5) * CELL, dx: 1, dy: 0, len: 40 * CELL, deep: 30 };
  const scour = await scourGpu(await theGpu(), bed, cuttable, [line], slope);
  const height = Float32Array.from(bed, (b, i) => b - scour[i]);
  return { scour, height, ends: [row * N + 60, row * N + 100] };
}

test("a scoured valley that reaches lower ground at its ends leaves no closed hollow, and the ice's adverse slope bounds the rest", async () => {
  // as the valley was once cut, with both ends walled off by the full depth: a hollow of nearly the whole 30 m (a slope of
  // 1 lets the floor rise nowhere)
  expect(await deepestHollow((await valley(1)).height)).toBeGreaterThan(20);
  // drained with no adverse slope at all
  const level = await valley(0);
  expect(await deepestHollow(level.height)).toBeLessThan(0.01);
  // drained with the adverse slope the ice could scour: the hollow is no deeper than that slope over half the valley
  expect(await deepestHollow((await valley(ADVERSE)).height)).toBeLessThanOrEqual(ADVERSE * 20 * CELL + 0.01);
  // the valley comes out at the ground at both ends, and is never cut deeper than the ice cleared it
  for (const i of level.ends) expect(level.scour[i]).toBe(0);
  expect(Math.max(...level.scour)).toBeLessThanOrEqual(30 + 1e-4);
});

test("the ice's valleys on islands 1 and 2 leave no hollow deeper than the adverse slope over half a valley and the till", async () => {
  // a valley is 5 km long at most, so each half is 2.5 km, and the till fills 6 m of any floor
  const bound = ADVERSE * 2500 + TILL_MAX;
  for (const seed of [1, 2]) {
    const up = await upstreamGpu(await theGpu(), rng(seed));
    let deepest = 0;
    for (let i = 0; i < LEN; i++) if (up.height[i] > 0 && up.filled[i] >= 0) deepest = Math.max(deepest, up.filled[i] - up.height[i]);
    expect([seed, deepest <= bound]).toEqual([seed, true]);
  }
}, 120_000);
