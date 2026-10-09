import { beforeAll, expect, test } from "bun:test";
import { DAY, TILE_M, addThing, isNight, newWorld, type Agent, type World } from "./world";
import { bedAir, fireHours, fireOf, fireOutput, hoursToDawn, removeThing } from "./physics";
import { advance } from "./combustion";
import { airAt } from "./air";
import { heatAt } from "./light";
import { feasible, needs } from "./sim";
import { YEAR_DAYS } from "./sky";

process.env.NOMADS_BRAIN = "random";

// What fires give people, read off docs/research/fire-constants.md before these were run (sec. 31): the radiant flux on
// someone, chi_r 0.3 of all a fire gives off over 4 pi (d^2 + r^2), raises the temperature their body feels by
// f_p q / (h_r + h_c) (sec. 18), which both the cold and the mild terms of needs() read; past 2.5 kW/m2 it burns by
// Purser's dose (sec. 7). The fires are the standard lay (physics.ts fireOf: fibre, ten twigs, five sticks and two logs)
// and a blaze of six logs, each five minutes after lighting, when the standard lay gives off about 115 kW in still air.
// The air is still and 2 C where the person stands, at night under cloud, so the sun, cold pooling and wind stay out of it.
// Time only runs forward here, a tick or more for each case, since what the air and fires give is worked out once a tick.

let island: World;
beforeAll(() => {
  island = newWorld(5);
  island.agents = island.agents.slice(0, 1);
  // a winter evening, eight o'clock
  island.t = Math.round((YEAR_DAYS * 7) / 8) * DAY + Math.round((20 / 24) * DAY);
}, 120_000);
// The world's one person, cold, on a patch of ground with nothing about them and no fire anywhere.
function cold() {
  const w = island, a = w.agents[0];
  for (const t of w.things.filter((t) => t.kind === "fire" || t.bed || Math.hypot(t.px - a.px, t.py - a.py) * TILE_M < 30)) removeThing(w, t);
  Object.assign(w.weather, { sky: "cloudy", speed: 0 });
  w.weather.temp += 2 - airAt(w, a.px, a.py).temp;
  w.t++;
  Object.assign(a, { goal: null, plan: [], inv: [], wearing: null, skin: 0, down: 0, struggles: undefined });
  Object.assign(a.needs, { food: 80, energy: 80, warmth: 30, health: 100, social: 80 });
  expect(isNight(w.t)).toBe(true);
  return { w, a };
}
// A fire this far east of them, m, five minutes after it was lit.
function fireAt(w: World, a: Agent, d: number, logs = 2) {
  const f = fireOf(w, a.px + d / TILE_M, a.py, 5, logs);
  f.bed = advance(f.bed!, 300, bedAir(w, f));
  w.t++;
  return f;
}
// Their warmth after so many ticks of needs where they are.
function after(w: World, a: Agent, ticks: number) {
  for (let i = 0; i < ticks; i++, w.t++) needs(w, a);
  return a.needs.warmth;
}

test("someone cold 1.5 m from a fire warms back up, more by a bigger fire, and the fire's warmth falls as one over the distance squared", () => {
  let { w, a } = cold();
  expect(after(w, a, 10)).toBeLessThan(30);

  ({ w, a } = cold());
  fireAt(w, a, 1.5);
  const campfire = after(w, a, 10);
  expect(campfire).toBeGreaterThan(30);

  ({ w, a } = cold());
  fireAt(w, a, 1.5, 6);
  expect(after(w, a, 10)).toBeGreaterThan(campfire);

  // a few fire-widths off, where the point source holds to 5% (sec. 7)
  ({ w, a } = cold());
  const f = fireAt(w, a, 0);
  const at = (d: number) => heatAt(w, f.px + d / TILE_M, f.py).q;
  expect(Math.abs(at(3) / at(6) - 4) / 4).toBeLessThan(0.05);
});

test("someone standing where a blaze throws 3 kW/m2 is hurt within the tick, which outlasts the dose that pains, while someone at a campfire's side isn't", () => {
  // where the six-log blaze throws 3 kW/m2: the pain dose, 1.33 (kW/m2)^(4/3) min, comes in 18 s there
  let { w, a } = cold();
  const blaze = fireAt(w, a, 0, 6);
  let lo = 0, hi = 10;
  for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (heatAt(w, blaze.px + mid / TILE_M, blaze.py).q > 3) lo = mid; else hi = mid; }

  ({ w, a } = cold());
  a.needs.warmth = 80;
  fireAt(w, a, lo, 6);
  expect(heatAt(w, a.px, a.py).q).toBeCloseTo(3, 1);
  needs(w, a);
  expect(a.needs.health).toBeLessThan(95);
  expect(a.needs.health).toBeGreaterThan(50);

  // someone lying collapsed there can't step back, and takes the whole tick's dose, past the third-degree one
  ({ w, a } = cold());
  a.needs.warmth = 80;
  fireAt(w, a, lo, 6);
  a.down = w.t + 60;
  needs(w, a);
  expect(a.needs.health).toBeLessThanOrEqual(0);

  // two metres off the standard lay, where people stand to tend it (world.ts reachOf)
  ({ w, a } = cold());
  a.needs.warmth = 80;
  fireAt(w, a, 2);
  expect(heatAt(w, a.px, a.py).q).toBeLessThan(2.5);
  needs(w, a);
  expect(a.needs.health).toBeGreaterThanOrEqual(100);
});

test("a bare fire thing with no bed gives no warmth", () => {
  const { w, a } = cold();
  addThing(w, "fire", a.px + 1.5 / TILE_M, a.py);
  w.t++;
  expect(heatAt(w, a.px, a.py).q).toBe(0);
  expect(after(w, a, 5)).toBeLessThan(30);
});

// Hours left are projected from the bed by the same closed forms (fire-constants sec. 28); the coals cut is when nothing
// flames (sec. 31).
test("a fire close by is one to tend at night while what burns in it won't last till dawn, and by day once only its coals glow", () => {
  let { w, a } = cold();
  const tend = () => { a.cooldowns = {}; a.inv = [{ k: "stick", hp: 1, born: w.t }]; return "tend_fire" in feasible(w, a).opts; };
  let f = fireAt(w, a, 2);
  expect(fireHours(w, f)).toBeLessThan(hoursToDawn(w.t));
  expect(tend()).toBe(true);

  // a quarter of an hour before dawn the same fire, just lit, outlasts the night
  let dawn = w.t;
  while (isNight(dawn)) dawn++;
  w.t = dawn - 5;
  ({ w, a } = cold());
  f = fireAt(w, a, 2);
  expect(fireOutput(w, f).flaming).toBeGreaterThan(0);
  expect(fireHours(w, f)).toBeGreaterThan(hoursToDawn(w.t));
  expect(tend()).toBe(false);

  // by day, flaming, and an hour on, burned down to its coals
  while (isNight(w.t)) w.t++;
  removeThing(w, f);
  f = fireAt(w, a, 2);
  expect(tend()).toBe(false);
  removeThing(w, f);
  f = fireAt(w, a, 2);
  f.bed = advance(f.bed!, 3600, bedAir(w, f));
  w.t++;
  expect(fireOutput(w, f).flaming).toBe(0);
  expect(tend()).toBe(true);
});
