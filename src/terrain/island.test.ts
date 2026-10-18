import { expect, test } from "bun:test";
import { rng } from "../sim/world";
import { ADVERSE, scourValley, upstream } from "./island";
import { TILL_MAX } from "./geology";
import { CELL, LEN, N, flood } from "./grid";

// The deepest closed hollow in a height field, m: how far the flooded surface stands above the ground at its worst cell.
function deepestHollow(h: Float32Array) {
  const { filled } = flood(h, 1e-4);
  let deepest = 0;
  for (let i = 0; i < LEN; i++) if (filled[i] >= 0) deepest = Math.max(deepest, filled[i] - h[i]);
  return deepest;
}

// A plane that rises eastward at 1%, with a 3 km joint valley along one row of it, 30 m deep, a sill in its middle.
function valley(slope: number) {
  const bed = new Float32Array(LEN), scour = new Float32Array(LEN), cuttable = new Uint8Array(LEN).fill(1);
  for (let i = 0; i < LEN; i++) bed[i] = 20 + 0.01 * CELL * (i % N);
  const row = 128, cells: number[] = [], at: number[] = [];
  for (let x = 60; x <= 100; x++) { cells.push(row * N + x); at.push((x - 60) / 40); }
  scourValley(scour, bed, cuttable, cells, at, 40 * CELL, 30, slope);
  const height = Float32Array.from(bed, (b, i) => b - scour[i]);
  return { scour, height, cells };
}

test("a scoured valley that reaches lower ground at its ends leaves no closed hollow, and the ice's adverse slope bounds the rest", () => {
  // as the valley was once cut, with both ends walled off by the full depth: a hollow of nearly the whole 30 m
  expect(deepestHollow(valley(1e9).height)).toBeGreaterThan(20);
  // drained with no adverse slope at all
  const level = valley(0);
  expect(deepestHollow(level.height)).toBeLessThan(0.01);
  // drained with the adverse slope the ice could scour: the hollow is no deeper than that slope over half the valley
  expect(deepestHollow(valley(ADVERSE).height)).toBeLessThanOrEqual(ADVERSE * 20 * CELL + 0.01);
  // the valley comes out at the ground at both ends, and is never cut deeper than the ice cleared it
  for (const k of [0, level.cells.length - 1]) expect(level.scour[level.cells[k]]).toBe(0);
  expect(Math.max(...level.scour)).toBeLessThanOrEqual(30);
});

test("the ice's valleys on islands 1 and 2 leave no hollow deeper than the adverse slope over half a valley and the till", () => {
  // a valley is 5 km long at most, so each half is 2.5 km, and the till fills 6 m of any floor
  const bound = ADVERSE * 2500 + TILL_MAX;
  for (const seed of [1, 2]) {
    const up = upstream(rng(seed));
    let deepest = 0;
    for (let i = 0; i < LEN; i++) if (up.height[i] > 0 && up.filled[i] >= 0) deepest = Math.max(deepest, up.filled[i] - up.height[i]);
    expect([seed, deepest <= bound]).toEqual([seed, true]);
  }
}, 120_000);
