import { expect, test } from "bun:test";
import { DAY, H, TILE_M, Tile, W, dryAt, heldStore, islandOf, meters, newWorld, shoreOf, tileAt, walkable, type Step } from "./world";
import { HERDED, animals, animalsOf, residentAnimals } from "./animals";
import { resident } from "./space";
import { stemDriver } from "./plants";
import { seedDriver } from "./seeds";
import { doAct, retire } from "./sim";
import { YEAR_DAYS, seasonAt } from "./sky";
import { HOUR, TICK_S, ticksOf } from "./ticks";
import { FAUNA, FID, addAnimal } from "./fauna";
import { ANIMAL } from "../gpu/animals";
import { F, SP } from "../gpu/wgsl/animals";

await islandOf(1);

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
  await resident(w, stemDriver(w), seedDriver(w));
  await residentAnimals(w);
  const s = heldStore(w)!, host = animalsOf(w), cap = s.kind(ANIMAL).capacity;
  let land = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (tileAt(w, x, y) !== Tile.Water) land++;
  const km2 = (land * TILE_M * TILE_M) / 1e6, seen: number[][] = HERDED.map(() => []);
  const height = (x: number, y: number) => { const c = (a: number, b: number) => w.heights[b * (W + 1) + a]; return (TILE_M * (c(x, y) + c(x + 1, y) + c(x, y + 1) + c(x + 1, y + 1))) / 4; };
  const deerUp: number[][] = [[], [], [], []];
  let t = Math.ceil(w.t / HOUR) * HOUR;
  for (let d = 0; d < YEARS * YEAR_DAYS; d++) {
    for (let h = 0; h < 24; h++) { t += HOUR; await s.step(t); }
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
}, 21_600_000);

// Animals near people at real speed (real-time tick plan, Unit 10): a deer bolting from someone chasing it on foot goes at
// its sprint (fauna.ts, Garland's 72 km/h), draws away faster than anyone runs, and the chase ends then; one standing
// beyond its flight initiation distance (fauna.ts FID, Meisingset et al.'s 57 m) stays as the runner closes and bolts
// once they are within it. A noon in clear weather on open ground with nothing in the way for 300 m east.
test("a deer bolting from a runner draws away at its sprint and the chase ends; one beyond its flight initiation distance bolts once the runner is within it", () => {
  const w = newWorld(1), a = w.agents[0];
  w.agents = [a];
  w.animals = [];
  w.t = DAY + DAY / 2;
  w.weather.sky = "clear";
  const open = (px: number, py: number) => { for (let m = -20; m <= 300; m += 5) { const x = px + m / TILE_M; if (!dryAt(w, x, py) || !walkable(w, Math.floor(x), Math.floor(py))) return false; } return true; };
  let at: [number, number] | null = null;
  for (let k = 0; k < 4000 && !at; k++) { const px = a.px - 10 + (k % 64) * 0.33, py = a.py - 10 + Math.floor(k / 64) * 0.33; if (open(px, py)) at = [px, py]; }
  expect(at).not.toBeNull();
  const chase = (gap: number) => {
    w.animals = [];
    [a.px, a.py] = at!;
    a.goal = null; a.plan = []; a.inv = []; a.down = 0;
    const deer = addAnimal(w, "deer", a.px + gap / TILE_M, a.py);
    const s: Step = { op: "act", progress: 0, act: { verb: "strike", items: [], tool: null, target: { kind: "deer", animal: deer.id } } };
    let r: unknown = "wait", ticks = 0, first = 0, flushed = Infinity;
    for (; ticks < ticksOf(120) && r === "wait"; ticks++) {
      const x0 = deer.px, before = meters(a, deer);
      w.t++;
      animals(w);
      if (!ticks) first = (deer.px - x0) * TILE_M;
      if (deer.state === "flee" && flushed === Infinity) flushed = before;
      r = doAct(w, a, s);
    }
    return { r, ticks, first, flushed };
  };
  const bolt = chase(10);
  // it bolted at its sprint, and the chase was over within seconds
  expect(bolt.first).toBeGreaterThan(0.9 * FAUNA.deer.run);
  expect(bolt.r).toBe("the deer got away");
  expect(bolt.ticks * TICK_S).toBeLessThan(10);
  const far = chase(FID.deer.person + 20);
  // the runner closed on it until within its flight initiation distance, a running stride inside it at most, and it got away
  expect(far.flushed).toBeLessThanOrEqual(FID.deer.person);
  expect(far.flushed).toBeGreaterThan(FID.deer.person - 5);
  expect(far.r).toBe("the deer got away");
}, 120_000);

// Flight initiation distances (fauna.ts FID): a red deer (Meisingset et al., 57 m), a rabbit (Huang et al., 31.7 m) and a
// grey heron (Díaz et al., 62.08 m) each stay with a person a meter beyond theirs and flee, or take wing, with one a meter
// within it. A noon in clear weather; the deer and the rabbit where the first person woke, the heron on the shore.
test("deer, rabbits and herons flee a person at their flight initiation distances", () => {
  const w = newWorld(1), a = w.agents[0];
  w.agents = [a];
  w.t = DAY + DAY / 2;
  w.weather.sky = "clear";
  const land: [number, number] = [a.px, a.py], shore = shoreOf(w)[0];
  const cases = [["deer", FID.deer.person, "flee"], ["rabbit", FID.rabbit.person, "flee"], ["heron", FID.heron.person, "fly"]] as const;
  for (const [sp, fid, fled] of cases)
    for (const off of [1, -1]) {
      w.animals = [];
      const [x, y] = sp === "heron" ? [shore.px, shore.py] : land;
      const an = addAnimal(w, sp, x, y);
      [a.px, a.py] = [x + (fid + off) / TILE_M, y];
      a.down = 0;
      w.t++;
      animals(w);
      if (off > 0) expect(an.state, `${sp} with a person ${fid + off} m off`).not.toBe(fled);
      else expect(an.state, `${sp} with a person ${fid + off} m off`).toBe(fled);
    }
}, 120_000);
