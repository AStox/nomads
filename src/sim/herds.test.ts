import { expect, test } from "bun:test";
import { DAY, H, TILE_M, Tile, W, newWorld, tileAt } from "./world";
import { HERDED, stepHerds } from "./herds";
import { YEAR_DAYS, seasonAt } from "./sky";

// The island's deer, rabbits, wolves and foxes hold steady on their own: over ten island years from the start every
// kind is still there, none drifts off to a boom or a crash (foxes and rabbits cycle over some years, so the two halves
// of the ten are set side by side), and each sits, as a rule, where the field puts it
// (docs/research/animal-constants.md sec. 9). Seed 1 is the play page's island, seed 5 the one the constants were
// checked on.
const FIELD = {
  deer: [1.7, 31.4], // a km2: Scotland's Deer Management Areas (R376)
  rabbit: [0, 25], // a ha: under where they run high (R377)
  wolf: [2, 99], // a 1000 km2: Yellowstone's Interior to its Northern Range (R381)
  fox: [0.21, 2.23], // a km2: rural Britain by landscape (R390)
} as const;
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;

for (const seed of [1, 5])
  test(`island ${seed}'s herds persist, hold steady and sit where the field puts them over ten years`, () => {
    const w = newWorld(seed), hs = w.herds!;
    let land = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (tileAt(w, x, y) !== Tile.Water) land++;
    const km2 = (land * TILE_M * TILE_M) / 1e6;
    const per = { deer: km2, rabbit: km2 * 100, wolf: km2 / 1000, fox: km2 };
    const seen: Record<string, number[]> = { deer: [], rabbit: [], wolf: [], fox: [] };
    for (let d = 0; d < YEAR_DAYS * 10; d++) {
      w.t += DAY;
      stepHerds(w, hs, 1, w.t);
      for (const sp of HERDED) seen[sp].push(hs[sp].n.reduce((s, x) => s + x, 0));
    }
    for (const sp of HERDED) {
      const n = seen[sp], half = YEAR_DAYS * 5;
      // still there, every day of the ten years
      expect(Math.min(...n)).toBeGreaterThan(5);
      // the second five years within a factor of two of the first
      const drift = mean(n.slice(half)) / mean(n.slice(0, half));
      expect(drift).toBeGreaterThan(0.5);
      expect(drift).toBeLessThan(2);
      // where the field puts them, as a rule
      const density = median(n) / per[sp];
      expect(density).toBeGreaterThanOrEqual(FIELD[sp][0]);
      expect(density).toBeLessThanOrEqual(FIELD[sp][1]);
    }
  }, 300_000);

// Nothing tells the deer where to go: they go where they'd feed best, so they follow the green up the hills in spring
// and summer and come down off them under winter's cold and snow.
test("island 1's deer climb the hills in spring and summer and come down in winter", () => {
  const w = newWorld(1), hs = w.herds!;
  const height = (i: number) => { const x = i % W, y = Math.floor(i / W), c = (a: number, b: number) => w.heights[b * (W + 1) + a]; return (TILE_M * (c(x, y) + c(x + 1, y) + c(x, y + 1) + c(x + 1, y + 1))) / 4; };
  const by: number[][] = [[], [], [], []];
  for (let d = 0; d < YEAR_DAYS * 3; d++) {
    w.t += DAY;
    stepHerds(w, hs, 1, w.t);
    let n = 0, up = 0;
    hs.deer.n.forEach((x, i) => { if (x > 0) { n += x; up += x * height(i); } });
    by[seasonAt(w.t).s].push(up / n);
  }
  const [spring, summer, , winter] = by.map(mean);
  expect(spring - winter).toBeGreaterThan(10);
  expect(summer - winter).toBeGreaterThan(10);
}, 300_000);
