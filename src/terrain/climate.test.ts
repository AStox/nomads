import { expect, test } from "bun:test";
import { rng } from "../sim/world";
import { generateIsland } from "./island";
import type { Climate, Season } from "./climate";

// Every number the climate lays down is a number: no cell of any field is NaN or infinite. The islands are made one after
// another in one process, as the sim and the tests make them, since a fault there once showed only on the third.
const FIELDS = ["precip", "snow", "snowCover", "fog", "temp", "pet", "sun", "sky", "pool", "breeze", "lee", "windShare", "salt"] as const satisfies readonly (keyof Climate)[];
const SEASON_FIELDS = ["precip", "pet", "sun", "temp", "humid", "snowpack"] as const satisfies readonly (keyof Season)[];
const unfinite = (f: ArrayLike<number>) => { let n = 0; for (let i = 0; i < f.length; i++) if (!Number.isFinite(f[i])) n++; return n; };

test("every climate field is finite on islands 1, 2 and 3", () => {
  for (const seed of [1, 2, 3]) {
    const isle = generateIsland(rng(seed));
    for (const k of FIELDS) expect([seed, k, unfinite(isle[k])]).toEqual([seed, k, 0]);
    isle.seasons.forEach((s, si) => { for (const k of SEASON_FIELDS) expect([seed, si, k, unfinite(s[k])]).toEqual([seed, si, k, 0]); });
    expect(isle.wind.every(Number.isFinite)).toBe(true);
  }
}, 300_000);
