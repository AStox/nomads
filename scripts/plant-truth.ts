// The truth about planting, to score people's theories against: someone standing at random dry spots all over the
// island pushes a berry into the ground the way anyone does (physics.ts plant: the first soil within a few paces), a
// batch at a random hour of every day of the year, each noted with the conditions a planter could have seen where it
// went in (the same tests as sim.ts CONDITIONS), or where they stood if it couldn't go in at all; then the world's own
// ecology runs until each has come up, withered, or sat in the ground 30 days.
//   bun scripts/plant-truth.ts <seed> <days> <perDay> > /tmp/plant-truth/<seed>.jsonl
// scripts/theory-report.ts --plant reads these.
import { DAY, W, H, dryAt, newWorld, type Thing } from "../src/sim/world";
import { ecology } from "../src/sim/ecology";
import { giveItems, groundWord, plant, raining } from "../src/sim/physics";
import { anyAround, put, thingById } from "../src/sim/space";
import { DARK, lightAt, skyShare } from "../src/sim/light";
import { soilWaterAt } from "../src/sim/soil";
import { airAt } from "../src/sim/air";
import { groundKey } from "../src/sim/beliefs";

const seed = Number(process.argv[2] ?? 1), days = Number(process.argv[3] ?? 40), per = Number(process.argv[4] ?? 20);
const w = newWorld(seed);
// one of the island's people, taken out of the world to do the planting and nothing else
const planter = w.agents[0];
w.agents = [];
type Sown = { t: Thing; at: number; conds: string[]; day: number };
// what a planter could see at a spot: the weather on them, and the spot itself
function conditionsAt(px: number, py: number) {
  const air = airAt(w, px, py), conds = [groundKey(groundWord(w, px, py))];
  if (raining(w)) conds.push("rain");
  if (lightAt(w, px, py).bright < DARK) conds.push("dark");
  if (air.feels < 0) conds.push("cold");
  if (air.wind > 8) conds.push("wind");
  if (skyShare(w, px, py) < 0.5) conds.push("shade");
  if (soilWaterAt(w, px, py) < 0.5) conds.push("dry");
  if (anyAround(w, px, py, 1.5, ["tree", "bush", "dead_bush"])) conds.push("crowded");
  return conds;
}
const sown: Sown[] = [], lines: string[] = [];
const note = (day: number, conds: string[], how: string, took: number) => lines.push(JSON.stringify({ day, conds, how, took }));
const settle = (s: Sown, how: string) => note(s.day, s.conds, how, (w.t - s.at) / DAY);
const t0 = performance.now();
// the world starts some hours into its first day: the first batch goes in at a random hour after that
let next = w.t + 1 + Math.floor(Math.random() * DAY);
while (w.t < (days + 30) * DAY) {
  w.t++;
  ecology(w);
  if (w.t === next && w.t < days * DAY) {
    for (let i = 0, guard = 0; i < per && guard < 10000; guard++) {
      const px = Math.random() * W, py = Math.random() * H;
      if (!dryAt(w, px, py)) continue;
      put(w, planter, px, py);
      planter.heading = Math.random() * Math.PI * 2;
      planter.inv = [];
      giveItems(w, planter, "berry");
      const got = plant(w, planter, { verb: "plant", items: ["berry"] }), t = thingById(w, got.later);
      i++;
      // nowhere within a few paces would take it: that's a planting that didn't come up, where they stood
      if (!t) { note(Math.floor(w.t / DAY), conditionsAt(px, py), "failed", 0); continue; }
      t.owner = undefined;
      sown.push({ t, at: w.t, conds: conditionsAt(t.px, t.py), day: Math.floor(w.t / DAY) });
    }
    next = (Math.floor(w.t / DAY) + 1) * DAY + Math.floor(Math.random() * DAY);
  }
  if (w.t % 12) continue;
  for (let i = sown.length - 1; i >= 0; i--) {
    const s = sown[i], now = thingById(w, s.t.id);
    const how = !now ? "withered" : now.kind !== "sapling" ? "came" : w.t - s.at >= 30 * DAY ? "pending" : null;
    if (how) { settle(s, how); sown.splice(i, 1); }
  }
}
for (const s of sown) settle(s, "pending");
console.error(`seed ${seed}: ${lines.length} planted, ${((performance.now() - t0) / 1000).toFixed(0)} s`);
console.log(lines.join("\n"));
process.exit(0);
