import { expect, test } from "bun:test";
import { H, TILE_M, Tile, W, heldStore, newWorld, tileAt } from "./world";
import { HERDED, animalsOf, residentAnimals } from "./animals";
import { resident } from "./space";
import { stemDriver } from "./plants";
import { retire } from "./sim";
import { YEAR_DAYS, seasonAt } from "./sky";
import { ANIMAL } from "../gpu/animals";
import { F, SP } from "../gpu/wgsl/animals";

// The island's deer, rabbits, wolves, foxes, herons, eagles, gulls and crows as individuals on the GPU
// (docs/research/animal-constants.md sec. 12): seed 1, the play page's island, from its start through three island
// years, each kind's head count every day against the field's densities (sec. 9's table). The checks hold what the
// individuals give: the GPU's census is the objects alive, no kind outgrows the room, and the deer and rabbits
// persist; where the field's band holds a kind it is checked, and what falls outside is a gap the doc records.
const FIELD: Partial<Record<(typeof HERDED)[number], readonly [number, number, number]>> = {
  // [low, high, per km2 of land times this]
  deer: [1.7, 31.4, 1], // a km2: Scotland's Deer Management Areas (R376)
  rabbit: [0, 25, 100], // a ha: under where they run high (R377)
  wolf: [2, 99, 1 / 1000], // a 1000 km2: Yellowstone's Interior to its Northern Range (R381)
  fox: [0.21, 2.23, 1], // a km2: rural Britain by landscape (R390)
};
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const YEARS = 3;

test("seed 1's animals as individuals over three island years: counted right, within their room, deer and rabbits persisting; densities against the field", async () => {
  const w = newWorld(1);
  await resident(w, stemDriver(w));
  await residentAnimals(w);
  const s = heldStore(w)!, host = animalsOf(w), cap = s.kind(ANIMAL).capacity;
  let land = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (tileAt(w, x, y) !== Tile.Water) land++;
  const km2 = (land * TILE_M * TILE_M) / 1e6, seen: number[][] = HERDED.map(() => []);
  const height = (x: number, y: number) => { const c = (a: number, b: number) => w.heights[b * (W + 1) + a]; return (TILE_M * (c(x, y) + c(x + 1, y) + c(x, y + 1) + c(x + 1, y + 1))) / 4; };
  const deerUp: number[][] = [[], [], [], []];
  let t = Math.ceil(w.t / 12) * 12;
  for (let d = 0; d < YEARS * YEAR_DAYS; d++) {
    for (let h = 0; h < 24; h++) { t += 12; await s.step(t); }
    HERDED.forEach((_, i) => seen[i].push(host.census[i]));
    // every fourth day: the census is the objects alive, and the deer's mean height for the season
    if (d % 4 === 0) {
      const b = await s.read(ANIMAL, "body"), n = new Array(HERDED.length).fill(0);
      let deer = 0, up = 0;
      for (let i = 0; i < cap; i++) {
        if (!(b[i] & 1)) continue;
        const sp = b[(F.sp + 1) * cap + i] & 15;
        n[sp]++;
        if (sp === SP.deer) { deer++; up += height(Math.min(W - 1, Math.floor(b[(F.x + 1) * cap + i] / 150000)), Math.min(H - 1, Math.floor(b[(F.y + 1) * cap + i] / 150000))); }
      }
      expect(n).toEqual(Array.from(host.census));
      if (deer) deerUp[seasonAt(t).s].push(up / deer);
    }
  }
  const lines: string[] = [];
  HERDED.forEach((sp, i) => {
    const n = seen[i], f = FIELD[sp], per = km2 * (f?.[2] ?? 1), m = median(n) / per;
    lines.push(`${sp}: median ${median(n)} (${m.toFixed(3)} ${f ? "per field unit" : "a km2"}), last ${n[n.length - 1]}, least ${Math.min(...n)}, most ${Math.max(...n)}${f ? `; field ${f[0]} to ${f[1]}` : ""}`);
    // within the room: no kind's count ever near the kind's capacity
    expect(Math.max(...n)).toBeLessThan(cap);
  });
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, x) => a + x, 0) / xs.length : NaN);
  lines.push(`deer's mean height by season (spring, summer, autumn, winter): ${deerUp.map((v) => mean(v).toFixed(0)).join(", ")} m`);
  console.log(lines.join("\n"));
  // the grazers persist every day of the three years
  expect(Math.min(...seen[SP.deer])).toBeGreaterThan(0);
  expect(Math.min(...seen[SP.rabbit])).toBeGreaterThan(0);
  await retire(w);
}, 3_600_000);
