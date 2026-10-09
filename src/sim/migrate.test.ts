import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DAY, TILE_M, VERSION, addThing, newWorld, type Agent, type Stack, type Thing, type World } from "./world";
import { ablaze, fireHours, giveItems, giveStack, shelterOf, strikeTick } from "./physics";
import { PHYS, pieceOf, stackPhys } from "./fuel";
import { beliefKey, record, type Belief } from "./beliefs";
import { DAMP, SOAKED, moistureOf } from "./wetness";
import { tick } from "./sim";
import { useBrain } from "./brain";
import { BACKUP, migrateSave } from "./migrate";

process.env.NOMADS_BRAIN = "random";

// A world in the shape a save had before fire was a bed of pieces, built by hand on a new one: a fire ringed with three
// stones at 200 hit points with half a charcoal's fuel left in it, an open fire at 14, a kiln at 30, an oak alight, a
// hazel scorched beside the open fire and another far from any, fiber held at old wetnesses, and the ways of lighting a
// fire the old physics taught, with a law, a plan step, a test and someone watching. Still, dry air, as plan.test.ts has.
type Old = Thing & { burning?: number; scorch?: number; heat?: number };
const OLD = "strike|fiber+stone|stone|stone|-|-";
const NEW = `strike|fiber+${Array<string>(10).fill("stick").join("+")}+stone|stone|stone|-|-`;
const RUB = "rub|stick+stick|-|-|-|-", RUB_LAY = "rub|stick+stick+fiber+stick+stick|-|-|-|-";
const TICK_H = 300 / 3600;

let w: World, a: Agent, dir: string, save: string, report: string[], saved: string;
let ringed: Old, open: Old, kiln: Old, oak: Old, near: Old, far: Old, wet: Stack[];
const at = (dx: number, dy = 0) => [a.px + dx / TILE_M, a.py + dy / TILE_M] as const;
const belief = (key: string, f: Partial<Belief["fields"]>, b: Partial<Belief>): Belief => ({
  key, fields: { verb: key.split("|")[0], inputs: key.split("|")[1].split("+"), gives: [], ...f }, uses: {}, out: {}, ticks: 9, tries: 7, wins: 4, how: "discovered", t: w.t, ...b,
});

beforeAll(() => {
  useBrain({ kind: "random" });
  w = newWorld(42);
  a = w.agents[0];
  Object.assign(w.weather, { sky: "clear", speed: 0 });
  w.t++;
  ringed = addThing(w, "fire", ...at(3), { owner: a.id, born: w.t, contained: true, charcoal: 75 });
  Object.assign(ringed, { hp: 200, maxHp: 400, heat: 1.3 });
  addThing(w, "structure", ...at(3), { owner: a.id, parts: { stone: 3 }, hp: 100, maxHp: 100, born: w.t, size: 1.6, shelter: { ...shelterOf(w, { stone: 3 }), tier: 0 } });
  open = addThing(w, "fire", ...at(-3), { owner: a.id, born: w.t });
  Object.assign(open, { hp: 14, maxHp: 400, heat: 1 });
  kiln = addThing(w, "fire", ...at(0, 20), { owner: a.id, born: w.t, contained: true, covered: true });
  Object.assign(kiln, { hp: 30, maxHp: 400, heat: 1.3 });
  addThing(w, "structure", ...at(0, 20), { owner: a.id, parts: { stone: 6 }, hp: 100, maxHp: 100, born: w.t, size: 1.6 });
  oak = addThing(w, "tree", ...at(0, -40), { species: "oak", size: 10, hp: 40, maxHp: 50 });
  oak.burning = 0.6;
  near = addThing(w, "bush", ...at(-3.3), { species: "hazel", size: 1 });
  far = addThing(w, "bush", ...at(0, 400), { species: "hazel", size: 1 });
  near.scorch = far.scorch = 0.5;
  wet = [0.2, 0.3, 0.6, 1].map((v) => ({ k: "fiber", hp: 1, born: w.t, wet: v }));
  a.inv.push(...wet);

  const law = `L${Object.keys(w.laws).length + 1}`;
  w.laws[OLD] = { id: law, key: OLD, text: "Striking stone on stone over fiber makes a fire.", verb: "strike", source: "physics", by: a.id, t: w.t, result: { gives: [], builds: "fire" } };
  a.beliefs[OLD] = belief(OLD, { tool: "stone", target: "stone", builds: "fire" }, {
    uses: { fiber: 1 }, law, tally: { tries: 7, wins: 4 }, when: { rain: { tries: 3, wins: 0 } }, mix: { rain: { tries: 3, wins: 0 }, "": { tries: 4, wins: 4 } }, unless: ["rain", "dark+!wind"],
  });
  a.plan = [{ op: "gather", arg: "fiber", progress: 0 }, { op: "act", key: OLD, arg: OLD, progress: 2, act: { verb: "strike", items: ["fiber"], tool: "stone", target: { kind: "stone" } } }];
  a.goal = { type: `test:rain@${OLD}`, since: w.t, odds: {}, fails: 0 };
  w.agents[1].beliefs[RUB] = belief(RUB, { builds: "fire" }, { unless: ["wind"] });
  w.agents[2].beliefs[RUB] = belief(RUB, { effect: "heat" }, {});
  w.agents[3].watching[OLD] = 0.4;

  // the save as the old server wrote it, and loaded
  dir = mkdtempSync(join(tmpdir(), "nomads-migrate-"));
  save = join(dir, "world.json");
  saved = JSON.stringify({ version: VERSION, things: [ringed, open, kiln], agents: [a] });
  writeFileSync(save, saved);
  report = migrateSave(save, w);
}, 120_000);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("an old fire is the usual lay as far burnt as its hours left, walled by its stone with its charcoal as coals; a ringed one at 200, with 33 hours left, is the most the usual lay lasts, and reported", () => {
  for (const f of [ringed, open, kiln]) {
    expect(ablaze(f)).toBe(true);
    expect([f.hp, f.maxHp, f.heat]).toEqual([undefined, undefined, undefined]);
  }
  expect(ringed.walls!.tall).toBeCloseTo(PHYS.stone.d);
  expect(ringed.walls!.width).toBeCloseTo(3 * PHYS.stone.d);
  expect(kiln.walls!.width).toBeCloseTo(6 * PHYS.stone.d);
  expect(open.walls).toBeUndefined();
  // half a charcoal's fuel left: half of one of fuel.ts's charcoal pieces, glowing at the heart
  expect(ringed.bed!.coals.some((c) => c.d === PHYS.charcoal.d && Math.abs(c.kg - PHYS.charcoal.mass / 2) < 1e-12)).toBe(true);
  // within a tick of their old hours, unreported: the open fire's 14 hit points, an hour and ten minutes, and the kiln's
  // 30, eight and a third hours under its cover
  expect(Math.abs(fireHours(w, open) - 14 / 12)).toBeLessThanOrEqual(TICK_H);
  expect(Math.abs(fireHours(w, kiln) - 30 / 0.3 / 12)).toBeLessThanOrEqual(TICK_H);
  expect(report.some((l) => l.includes(open.id) || l.includes(kiln.id))).toBe(false);
  // a bed lasts as long as its slowest piece, a 17 cm log, about an hour and a quarter: far short of 200 / 0.5 / 12
  expect(fireHours(w, ringed)).toBeGreaterThan(1);
  expect(fireHours(w, ringed)).toBeLessThan(1.5);
  expect(report.find((l) => l.includes(ringed.id))).toContain("33.33 h");
});

test("an old strike over fiber alone is the lay of fiber and ten twigs, keeping its theories with its record cleared, and its law, plan step, test and watching follow it", () => {
  expect(a.beliefs[OLD]).toBeUndefined();
  const b = a.beliefs[NEW];
  expect(b.key).toBe(NEW);
  expect(b.fields.inputs).toEqual(NEW.split("|")[1].split("+"));
  expect(b.uses).toEqual({ fiber: 1, stick: 10 });
  expect(b.unless).toEqual(["rain", "dark+!wind"]);
  expect([b.tries, b.wins, b.tally, b.when, b.mix]).toEqual([0, 1, { tries: 0, wins: 0 }, undefined, undefined]);
  expect(w.laws[OLD]).toBeUndefined();
  expect(w.laws[NEW].id).toBe(b.law!);
  expect(a.plan[1]).toEqual({ op: "act", key: NEW, arg: NEW, progress: 2 });
  expect(a.goal!.type).toBe(`test:rain@${NEW}`);
  expect(w.agents[3].watching).toEqual({ [NEW]: 0.4 });
  // a rub that lit a fire is its two sticks rubbed over fiber and both sticks; one that only made them hot stays
  expect(w.agents[1].beliefs[RUB]).toBeUndefined();
  expect(w.agents[1].beliefs[RUB_LAY].unless).toEqual(["wind"]);
  expect(w.agents[2].beliefs[RUB].fields.effect).toBe("heat");
});

test("fiber held at the old wetness keeps its catching: under 0.3 a spark catches, under 0.6 an ember, and at 0.6 it's soaked", () => {
  const [dry, damp, soaked, through] = wet.map((s) => moistureOf(s));
  expect(dry).toBeLessThanOrEqual(DAMP);
  expect(damp).toBeGreaterThan(DAMP);
  expect(damp).toBeLessThanOrEqual(SOAKED);
  expect(soaked).toBeGreaterThan(SOAKED);
  expect(through).toBeCloseTo(stackPhys(w.kinds, wet[3])!.mmax);
  expect(wet.some((s) => "wet" in s)).toBe(false);
});

test("an oak alight burns as a bed of its own pieces; a scorched bush beside a fire keeps heat toward lighting, and one far from any keeps none", () => {
  expect(ablaze(oak)).toBe(true);
  expect(near.absorbed?.some((v) => v > 0)).toBe(true);
  expect(far.absorbed).toBeUndefined();
  expect([oak.burning, near.scorch, far.scorch]).toEqual([undefined, undefined, undefined]);
});

test("the save as it was is kept before anything migrated is saved over it, and a second load changes nothing and keeps it", () => {
  expect(readFileSync(save + BACKUP, "utf8")).toBe(saved);
  const now = JSON.stringify({ things: w.things, agents: w.agents, laws: w.laws, weather: w.weather });
  writeFileSync(save, JSON.stringify({ version: VERSION, things: [ringed, open, kiln], agents: [a] }));
  expect(migrateSave(save, w)).toEqual([]);
  expect(JSON.stringify({ things: w.things, agents: w.agents, laws: w.laws, weather: w.weather })).toBe(now);
  expect(readFileSync(save + BACKUP, "utf8")).toBe(saved);
});

test("struck over fiber and ten twigs, the migrated way lights a fire under its own key and finds no new law", () => {
  Object.assign(w.weather, { sky: "clear", speed: 0 });
  w.t++;
  a.inv = [];
  giveItems(w, a, "stone", 2);
  giveStack(w, a, { k: "fiber", hp: 1, born: w.t, m: 0.06 });
  const twig = pieceOf({ kind: "stick", size: 0.5 }, "stick")!;
  for (let i = 0; i < 10; i++) giveStack(w, a, { k: "stick", hp: 1, born: w.t, m: 0.1, ...twig });
  const st = { progress: 0 };
  let r;
  do r = strikeTick(w, a, { verb: "strike", items: ["fiber", ...Array<string>(10).fill("stick")], tool: "stone", target: { kind: "stone" } }, st); while (!r.done);
  const out = r.out!;
  expect(out.fields.builds).toBe("fire");
  expect(beliefKey(out.fields)).toBe(NEW);
  const laws = Object.keys(w.laws).length, found = w.events.filter((e) => e.kind === "law").length;
  record(w, a, out, st.progress);
  expect(Object.keys(w.laws).length).toBe(laws);
  expect(w.events.filter((e) => e.kind === "law").length).toBe(found);
  expect(a.beliefs[NEW].tries).toBe(1);
});

test("the migrated world lives a day", async () => {
  // nothing in the migrated world throws as it ticks: what's asked of a day is only that it runs
  for (let i = 0; i < DAY; i++) {
    tick(w);
    for (let k = 0; k < 20; k++) await Promise.resolve();
  }
}, 120_000);
