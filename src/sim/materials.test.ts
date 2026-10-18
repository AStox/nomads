import { afterAll, expect, test } from "bun:test";
import { DAY, TILE_M, addThing, adoptStore, dryAt, islandOf, newWorld, rng, shoreOf, wetAt, type Act, type Agent, type Thing, type World } from "./world";
import { HOUR, ticksOf } from "./ticks";
import { WEATHER_NOW, bedAir, count, eat, fireOf, giveItems, giveStack, heat, join, openWater, place, removeThing, strikeTick, throwReach, throwTick, wet, type Fields, type Outcome } from "./physics";
import { BURNS, COPPER, PHYS, pieceOf } from "./fuel";
import { BLADE, GROWN } from "./mechanics";
import { basketOf, catchChances } from "./hunt";
import { advance } from "./combustion";
import { predictMaterial } from "./formulas";
import { addAnimal } from "./fauna";
import { fishDriver, fishOf, meeting, takeFish, waterHere, watersOf } from "./waters";
import { streamNow } from "./streams";
import { Store } from "../gpu/store";
import { FISH } from "../gpu/fish";
import { FS, SUB, SUB_MM, TILE_MM } from "../gpu/wgsl/fish";
import { releaseGpu, theGpu } from "../gpu/device";
import { CELL, N } from "../terrain/grid";
import { CELL_MM } from "../gpu/wgsl/index";
import { put as moveTo, thingById } from "./space";
import { conditionsNow } from "./sim";
import { hooks } from "./rules";
import { DAMP } from "./wetness";
import { ecology, forecast } from "./ecology";
import { ahead, bedAt, seedlingFate } from "./seedling";
import { fitHere } from "./plants";

await islandOf(42);

afterAll(releaseGpu);
// A fire burning so many seconds (ten minutes unless said) from the usual lay (fireOf), under a clear sky with a breeze
// blowing u m/s.
const burning = (u = 2, sticks = 5, logs = 2, age = 600): [World, Agent, Thing] => {
  const [w, a] = fresh();
  Object.assign(w.weather, { sky: "clear", speed: u });
  w.t++;
  const fire = fireOf(w, a.px, a.py, sticks, logs);
  fire.bed = advance(fire.bed!, age, bedAir(w, fire));
  return [w, a, fire];
};
const fresh = (): [World, Agent] => { const w = newWorld(42); const a = w.agents[0]; a.inv = []; return [w, a]; };
// Born long ago: the million five-minute ticks these cases first set a person's birth back by [design: the age they
// were written for, which a million 1 s ticks would make a child].
const LONG_AGO = ticksOf(1e6 * 300);
const heated = (w: World, a: Agent, act: Omit<Act, "verb">): Outcome => {
  const r = heat(w, a, { verb: "heat", ...act });
  if (r === "ask") throw new Error("the heat rules should cover this");
  return r;
};
const put = (w: World, a: Agent, k: string, n: number) => { giveItems(w, a, k, n); return place(w, a, { verb: "place", items: Array(n).fill(k) }); };
// Stone laid round a fire three at a time until it closes round its bed, a hearth (physics.ts placing); then heaped on
// until it covers the ring's mouth, a kiln (shelter.ts lidOf): what the last of it came to.
const ringed = (w: World, a: Agent, fire: Thing) => { let r: Outcome | undefined; for (let i = 0; i < 100 && !fire.contained; i++) r = put(w, a, "stone", 3); return r; };
const heaped = (w: World, a: Agent, fire: Thing) => { let r = ringed(w, a, fire); for (let i = 0; i < 200 && !fire.covered; i++) r = put(w, a, "stone", 3); return r; };
// One try of striking something held, blow by blow until it comes to something; lay: what it's struck over, if anything
const hammer = (w: World, a: Agent, tool: string, target: string, lay: string[] = []) => {
  const st = { progress: 0 };
  let r;
  do r = strikeTick(w, a, { verb: "strike", items: lay, tool, target: { kind: target } }, st); while (!r.done);
  return r.out!;
};
// Ten half-meter twigs off the ground (fuel.ts pieces), dry as wood kept in: kindling laid with tinder.
const TWIG = pieceOf({ kind: "stick", size: 0.5 }, "stick")!.size;
const twigs = (w: World, a: Agent) => { for (let i = 0; i < 10; i++) giveStack(w, a, { k: "stick", hp: 1, born: w.t, m: 0.12, size: TWIG }); return Array<string>(10).fill("stick"); };

test("clay set in a burning fire fires hard, as pots do in a bonfire, and not in a small fire's few coals; ore gives up its copper only when air is blown into the coals", () => {
  const [w, a] = burning();
  giveItems(w, a, "clay");
  const pot = heated(w, a, { items: ["clay"] });
  expect(pot.ok).toBe(true);
  expect(pot.fields.at).toBe("fire");
  giveItems(w, a, "ore");
  expect(heated(w, a, { items: ["ore"] }).effect).toBe("too_cool");
  giveItems(w, a, "fiber", 3);
  const mat = join(w, a, { verb: "join", items: ["fiber", "fiber", "fiber"] });
  if (mat === "ask") throw new Error();
  const lump = heated(w, a, { items: ["ore"], tool: Object.keys(mat.gives)[0] });
  expect(lump.ok).toBe(true);
  expect(w.kinds[Object.keys(lump.gives)[0]].props.metal).toBe(1);
  // a lay of fibre and twigs a minute after lighting: flames gone and a few coals that can't bury a lump of clay
  const [v, b] = burning(2, 0, 0, 60);
  giveItems(v, b, "clay");
  expect(heated(v, b, { items: ["clay"] }).effect).toBe("too_cool");
  expect(count(b, "clay")).toBe(1);
});

test("a stick set in an open fire catches and is carried off alight; under stone heaped over the same fire it smoulders to charcoal, and a log is still wood when they take it out", () => {
  const [w, a, fire] = burning();
  giveItems(w, a, "stick");
  expect(Object.keys(heated(w, a, { items: ["stick"] }).gives)[0]).toBe("burning:stick");
  expect(heaped(w, a, fire)!.builds).toBe("kiln");
  expect(fire.covered).toBe(true);
  giveItems(w, a, "stick");
  expect(heated(w, a, { items: ["stick"] }).gives).toEqual({ charcoal: 1 });
  giveItems(w, a, "log");
  expect(heated(w, a, { items: ["log"] }).effect).toBe("too_cool");
  expect(count(a, "log")).toBe(1);
});

test("meat set in a small fire of twigs and sticks cooks through; under a cover it cooks in the smoke and comes out smoked", () => {
  const [w, a] = burning(2, 5, 0, 120);
  giveItems(w, a, "meat");
  expect(Object.keys(heated(w, a, { items: ["meat"] }).gives)[0]).toBe("cooked:meat");
  const [v, b] = burning();
  heaped(v, b, v.things.find((t) => t.kind === "fire")!);
  giveItems(v, b, "meat");
  expect(Object.keys(heated(v, b, { items: ["meat"] }).gives)[0]).toBe("smoked:meat");
});

test("a hide hung over an open fire scorches, and over the same fire heaped over it cures in the smoke", () => {
  const [w, a, fire] = burning();
  giveItems(w, a, "hide");
  expect(heated(w, a, { items: ["hide"] }).effect).toBe("scorched");
  heaped(w, a, fire);
  const cured = heated(w, a, { items: ["hide"] });
  expect(cured.ok).toBe(true);
  expect(Object.keys(cured.gives)[0]).toBe("leather:hide");
});

test("the staged fire, hearth, kiln and forge the answer key asks give what acts at fires laid and set up the same way give", () => {
  for (const at of ["fire", "hearth", "kiln", "forge"] as const) {
    const [w, a, fire] = burning(0);
    if (at !== "fire") ringed(w, a, fire);
    if (at === "kiln") heaped(w, a, fire);
    // fed the charcoal a log smothers into and burnt ten minutes on, as the answer key stages a forge (formulas.ts)
    if (at === "forge") {
      giveStack(w, a, { k: "charcoal", hp: 1, born: w.t, size: { d: PHYS.log.d, len: 1, mass: PHYS.log.mass * BURNS.softwood.charYield } });
      place(w, a, { verb: "place", items: ["charcoal"] });
      fire.bed = advance(fire.bed!, 600, bedAir(w, fire));
    }
    giveItems(w, a, "fiber", 3);
    const mat = join(w, a, { verb: "join", items: ["fiber", "fiber", "fiber"] });
    if (mat === "ask") throw new Error();
    const fan = Object.keys(mat.gives)[0];
    for (const [items, tool] of [[["meat"]], [["ore"]], [["ore"], fan], [["stick"]]] as [string[], string?][]) {
      giveItems(w, a, items[0]);
      const f: Fields = { verb: "heat", inputs: items, at, gives: [], ...(tool ? { tool } : {}) };
      const said = predictMaterial(w, f), done = heated(w, a, { items, ...(tool ? { tool } : {}) });
      expect([at, items[0], tool, "ok" in said && said.ok, "ok" in said && said.gives]).toEqual([at, items[0], tool, done.ok, done.fields.gives]);
    }
  }
});

test("hammering copper red hot at a charcoal fire draws its edge out into a blade; cold, it hardens before the edge is thin enough for one", () => {
  const [w, a, fire] = burning();
  ringed(w, a, fire);
  put(w, a, "charcoal", 3);
  w.kinds.lump = { id: "lump", name: "metal lump", props: { hard: 0.8, heavy: 0.85, metal: 1, toughness: 0.85 }, parts: ["ore"], verb: "heat", phys: COPPER };
  giveItems(w, a, "stone", 2); giveItems(w, a, "lump", 2);
  const edge = (o: Outcome) => w.kinds[Object.keys(o.gives)[0]].phys!.edge!.r * 2;
  const cold = hammer(w, a, "stone", "lump");
  expect(cold.ok).toBe(true);
  expect(edge(cold)).toBeGreaterThan(BLADE);
  const hot = hammer(w, a, "stone", Object.keys(heated(w, a, { items: ["lump"] }).gives)[0]);
  expect(hot.ok).toBe(true);
  expect(hot.fields.at).toBe("forge");
  expect(edge(hot)).toBeLessThanOrEqual(BLADE * 1.001);
});

// Fill someone's hands with one kind until the next one won't go (gait.ts canHold, by mass and bulk): how many they hold.
const fill = (w: World, a: Agent, k: string) => { while (giveItems(w, a, k) === 1); return count(a, k); };
test("hands full of stone still make room for food", () => {
  const [w, a] = fresh();
  a.born = w.t - LONG_AGO;
  for (const k of ["stick", "clay", "fiber", "bone"]) giveItems(w, a, k);
  const stones = fill(w, a, "stone");
  expect(stones).toBeGreaterThan(1);
  // three kilograms of berries as picked, more than the stone that wouldn't go weighs
  expect(giveItems(w, a, "berry", 12, PHYS.berry.green)).toBe(12);
  expect(count(a, "berry")).toBe(12);
  expect(count(a, "stone")).toBeLessThan(stones);
});

test("hands full of food still make room for a stick", () => {
  const [w, a] = fresh();
  a.born = w.t - LONG_AGO;
  const grain = fill(w, a, "grain");
  expect(giveItems(w, a, "stick")).toBe(1);
  expect(count(a, "stick")).toBe(1);
  expect(count(a, "grain")).toBeLessThan(grain);
});

// Whether a try comes off follows from what anyone trying could notice: the same things in hand, weather and spot give
// the same outcome every time, and changing what decides it changes it.
test("struck over fiber laid with twigs, pyrite shaved by flint or a plain stone lights it at the same stroke every time; two stones never do; over damp fiber or in a gale the sparks never catch, and over sticks alone they never do", () => {
  const [w, a] = fresh();
  const light = (tool: string, target: string, over: string, wet = 0) => {
    a.inv = [];
    giveItems(w, a, tool); giveItems(w, a, target); giveItems(w, a, over, 1, wet);
    return hammer(w, a, tool, target, [over, ...twigs(w, a)]);
  };
  w.weather.sky = "clear";
  w.weather.speed = 2;
  const stone = Array.from({ length: 5 }, () => light("stone", "pyrite", "fiber"));
  expect(stone.every((o) => o.builds === "fire")).toBe(true);
  expect(new Set(stone.map((o) => o.numbers?.blows)).size).toBe(1);
  expect(light("flint", "pyrite", "fiber").builds).toBe("fire");
  expect(light("stone", "stone", "fiber").ok).toBe(false);
  expect(light("stone", "flint", "fiber").ok).toBe(false);
  // at the spark limit it still catches; just wetter, it never does
  expect(light("stone", "pyrite", "fiber", DAMP).builds).toBe("fire");
  expect(Array.from({ length: 3 }, () => light("stone", "pyrite", "fiber", DAMP + 0.01)).every((o) => !o.ok)).toBe(true);
  // the air where they stand is worked out once a tick: a new wind, a new tick; out from under the crowns, which keep a
  // gale off (air.ts headWind)
  for (const t of w.things.filter((t) => t.kind === "tree" && Math.hypot(t.px - a.px, t.py - a.py) * TILE_M < 15)) removeThing(w, t);
  w.weather.speed = 60;
  w.t++;
  expect(WEATHER_NOW.wind(w, a)).toBe(true);
  expect(light("stone", "pyrite", "fiber").ok).toBe(false);
  w.weather.speed = 2;
  w.t++;
  expect(light("stone", "pyrite", "stick").ok).toBe(false);
});

test("a stone struck with a stone or a stick knocks off a sharp stone at every blow until the core is spent; bare hands knock off nothing", () => {
  const [w, a] = fresh();
  a.born = w.t - LONG_AGO;
  giveItems(w, a, "stone", 2); giveItems(w, a, "stick");
  const flakes = (PHYS.stone.mass / PHYS.sharp_stone.mass) | 0;
  let n = 0;
  while (count(a, "stone") === 2 && n < 100) { a.inv = a.inv.filter((s) => s.k !== "sharp_stone"); if (hammer(w, a, "stone", "stone").gives.sharp_stone === 1) n++; }
  expect(n).toBe(flakes);
  expect(count(a, "stone")).toBe(1);
  expect(hammer(w, a, "stick", "stone").gives.sharp_stone).toBe(1);
  const bare = strikeTick(w, a, { verb: "strike", items: [], tool: null, target: { kind: "stone" } }, { progress: 0 }).out!;
  expect(bare.ok).toBe(false);
});

test("felling an oak with a hafted flint blade peels the same strips of bark every time, and the oak gives logs and sticks; a stone in the fist never cuts it", () => {
  const [w, a] = fresh();
  a.born = w.t - LONG_AGO;
  w.kinds.axe = { id: "axe", name: "flint axe", props: { sharp: 0.9 }, parts: ["flint_blade", "stick"], verb: "join" };
  // tree: an oak this tall; sharp: the axe kept sharp, as if resharpened whenever it dulled
  const fell = (tool: string, size: number, sharp = false) => {
    const tree = addThing(w, "tree", a.px, a.py, { size, species: "oak", hp: 100, maxHp: 100 });
    a.inv = [];
    giveItems(w, a, tool);
    const st = { progress: 0 };
    let r;
    do { if (sharp) for (const s of a.inv) s.hp = 1; r = strikeTick(w, a, { verb: "strike", items: [], tool, target: { kind: "tree", thing: tree.id } }, st); } while (!r.done);
    return { out: r.out!, bark: tree.bark ?? 0 };
  };
  const young = [fell("axe", 10), fell("axe", 10)];
  expect(young.every((f) => f.out.ok && f.out.gives.log! >= 1 && f.out.gives.stick! > 1)).toBe(true);
  expect(young[1].out.gives).toEqual(young[0].out.gives);
  // a big oak dulls the edge many times over before it's down; kept sharp, it gives its bark over the notch
  expect(fell("axe", 25).out.ok).toBe(false);
  const old = [fell("axe", 25, true), fell("axe", 25, true)];
  expect(old[0].out.ok).toBe(true);
  expect(old[0].bark).toBeGreaterThan(0);
  expect(old[1].bark).toBe(old[0].bark);
  expect(fell("stone", 10).out.ok).toBe(false);
});

test("a line or a basket dipped near the shore catches only fish of the water it is dipped in, never one of other water close by: with none of its own about it never does, and anyone dipping sees there were no fish close by", async () => {
  const [w, a] = fresh();
  const s = new Store(await theGpu());
  adoptStore(w, s);
  await fishOf(w).attach(s, { ...fishDriver(w), days: 0, start: () => new Uint32Array(0) });
  const v = watersOf(w.seed), mm = (p: number) => Math.round(p * TILE_M * 1000);
  // a shore where they dip into one body of water and a square of another lies within a line's reach
  let other: [number, number] | null = null, own: [number, number] | null = null;
  for (const sp of shoreOf(w)) {
    moveTo(w, a, sp.px, sp.py);
    const body = waterHere(w, a);
    if (!openWater(w, a) || body < 0) continue;
    const cx = Math.floor((a.px * TILE_M) / CELL), cy = Math.floor((a.py * TILE_M) / CELL);
    other = null;
    for (let y = cy - 1; y <= cy + 1 && !other; y++) for (let x = cx - 1; x <= cx + 1 && !other; x++) {
      const c = y * N + x;
      if (!v.kind[c] || v.body[c] === body) continue;
      for (let q = 0; q < SUB * SUB && !other; q++) {
        if (!(((q < 32 ? v.m0[c] >>> q : v.m1[c] >>> (q - 32)) & 1) === 1)) continue;
        const ox = x * CELL_MM + (q % SUB) * SUB_MM + Math.floor(SUB_MM / 2), oy = y * CELL_MM + Math.floor(q / SUB) * SUB_MM + Math.floor(SUB_MM / 2);
        if (Math.hypot(ox - mm(a.px), oy - mm(a.py)) <= 30000) other = [ox, oy];
      }
    }
    if (!other) continue;
    // the open water of their own body they dip into, a pace or two off (waterHere's points)
    for (let k = -1; k < 8 && !own; k++) {
      const r = k < 0 ? 0 : 3 / TILE_M, x = a.px + Math.cos((k * Math.PI) / 4) * r, y = a.py + Math.sin((k * Math.PI) / 4) * r;
      const c = Math.floor((y * TILE_M) / CELL) * N + Math.floor((x * TILE_M) / CELL);
      if (v.kind[c] && v.body[c] === body && (wetAt(w, x, y) || streamNow(w, x, y)?.flowing)) own = [mm(x), mm(y)];
    }
    if (own) break;
  }
  expect(other && own).toBeTruthy();
  s.mirror.watch("test", { x0: Math.floor((a.px * TILE_M) / CELL) - 2, y0: Math.floor((a.py * TILE_M) / CELL) - 2, x1: Math.floor((a.px * TILE_M) / CELL) + 2, y1: Math.floor((a.py * TILE_M) / CELL) + 2 });
  const fish = (at: [number, number]) => s.spawn(FISH, { x: at[0], y: at[1], sp: FS.perch | 16, born: 0, len: 200000 });
  const step = async () => { w.t++; if (w.t % DAY === 0) w.t++; await s.step(w.t); };
  w.kinds.line = { id: "line", name: "line", props: { long: 0.7, flexible: 0.9, binding: 0.8 } };
  w.kinds.basket = { id: "basket", name: "basket", props: { container: 0.7, fibrous: 0.8 } };
  const dip = (k: string) => { if (!count(a, k)) giveItems(w, a, k); return wet(w, a, { verb: "wet", items: [k], at: "water" }); };
  // a fish of other water within a line's reach: nothing bites, and no fish of theirs was close by
  const stranger = fish(other!);
  await step();
  const strangerId = s.mirror.spawned(stranger.id)?.id ?? stranger.id;
  for (const k of ["line", "basket"]) {
    expect(dip(k).ok).toBe(false);
    expect(conditionsNow(w, a, "wet")).toContain("nofish");
    await step();
  }
  // two fish of their own water in the cell they dip into: a gear can meet them both, and not the stranger
  const mine = [fish(own!), fish(own!)];
  await step();
  const ids = mine.map((o) => s.mirror.spawned(o.id)?.id ?? o.id);
  expect(meeting(w, a).fish.map((f) => f.id).sort()).toEqual([...ids].sort());
  expect(conditionsNow(w, a, "wet")).not.toContain("nofish");
  // dipped until something comes up (each fish meets the gear at its own rate): only theirs ever do, and each caught is
  // gone from the water
  for (const k of ["line", "basket"]) {
    let out: Outcome | undefined;
    for (let i = 0; i < 400 && !out?.ok; i++) out = dip(k);
    expect(out?.ok).toBe(true);
    await step();
    expect(ids.some((id) => s.mirror.get(id) === null)).toBe(true);
    expect(s.mirror.get(strangerId)).not.toBeNull();
    if (ids.every((id) => s.mirror.get(id) === null)) break;
  }
  // the stranger still swims in its own water, and with none of theirs left nothing comes up
  takeFish(w, ids.filter((id) => s.mirror.get(id) !== null));
  await step();
  expect(s.mirror.get(strangerId)).not.toBeNull();
  for (const k of ["line", "basket"]) {
    expect(dip(k).ok).toBe(false);
    expect(conditionsNow(w, a, "wet")).toContain("nofish");
    await step();
  }
  for (const verb of ["strike", "rub", "plant"]) expect(conditionsNow(w, a, verb)).not.toContain("nofish");
  fishOf(w).destroy(); s.destroy();
}, 600_000);

test("a fish meets a gear the more often the longer it is and the smaller the water it ranges over", () => {
  const basket = basketOf(PHYS.fiber, GROWN.basal);
  for (const gear of [{ line: true } as const, { line: false, ...basket } as const]) {
    const [small, big] = catchChances(gear, { fish: [{ id: 1, cm: 15 }, { id: 2, cm: 40 }], area: 5625 }, 3000);
    expect(big).toBeGreaterThan(small);
    const [narrow] = catchChances(gear, { fish: [{ id: 1, cm: 15 }], area: 500 }, 3000);
    expect(narrow).toBeGreaterThan(small);
  }
});

test("a throw falls short of an animal beyond its reach and comes down short of it; within reach a stone can hit a deer, but only bruises it", () => {
  const [w, a] = fresh();
  w.animals = [];
  const deer = addAnimal(w, "deer", a.px + 3 / TILE_M, a.py);
  const act: Act = { verb: "throw", items: ["stone"], target: { kind: "deer", animal: deer.id } };
  const reach = throwReach(w, a, act, deer);
  expect(reach).toBeGreaterThan(3);
  const toss = () => { giveItems(w, a, "stone"); const st = { progress: 0 }; let r; do r = throwTick(w, a, act, st); while (!r.done); return r.out!; };
  moveTo(w, deer, a.px + (reach + 5) / TILE_M, a.py);
  for (let i = 0; i < 3; i++) expect(toss().text).toContain("fell short");
  const lying = w.things.filter((t) => t.kind === "item" && t.item === "stone");
  expect(lying.length).toBeGreaterThan(0);
  for (const t of lying) expect(t.px).toBeLessThan(deer.px);
  // within reach: some stones strike it, none brings it down (a blow short of serious injury by the blunt criterion)
  moveTo(w, deer, a.px + 3 / TILE_M, a.py);
  let struck = 0;
  for (let i = 0; i < 40; i++) {
    deer.state = "graze";
    const out = toss();
    expect(out.ok).toBe(false);
    if (out.text.includes("glanced")) struck++;
  }
  expect(struck).toBeGreaterThan(0);
});

test("raw meat makes whoever eats it sick every time; raw fish and cooked meat never do", () => {
  const [w, a] = fresh();
  w.kinds.roast = { id: "roast", name: "cooked meat", props: { edible: 0.5, toxic: 0.045 } };
  for (const [k, sick] of [["meat", true], ["fish", false], ["roast", false]] as const)
    for (let i = 0; i < 4; i++) {
      giveItems(w, a, k);
      const out = eat(w, a, k);
      expect(out.effect === "sick").toBe(sick);
      expect(out.ok).toBe(!sick);
    }
});

test("a seedling's hours ahead come to what ecology makes of the same weather, hour by hour", () => {
  const [w, a] = fresh();
  // nobody about to feed the soil with dung, nothing roaming: the seedling alone with its spot and the weather
  w.agents = [];
  w.animals = [];
  // a spot that suits berries well, the nearest to where they started (a fit over a half [design]): they start on the
  // marsh, where a seedling only burns down, and its soil's water would count for nothing
  let spot: { px: number; py: number } | undefined;
  for (let m = 5; m <= 400 && !spot; m += 5)
    for (let k = 0; k < 16 && !spot; k++) {
      const px = a.px + (Math.cos((k * Math.PI) / 8) * m) / TILE_M, py = a.py + (Math.sin((k * Math.PI) / 8) * m) / TILE_M;
      if (dryAt(w, px, py) && fitHere(w, "berry", px, py) > 0.5) spot = { px, py };
    }
  if (!spot) throw new Error("no ground near them suits berries");
  // the weather ecology will give it: a seeded stretch of the island's own
  const hours = forecast(w, 30 * 24, rng(7));
  const fate = seedlingFate(bedAt(w, spot.px, spot.py, "berry"), ahead(w, spot.px, spot.py, w.t, hours));
  const t = addThing(w, "sapling", spot.px, spot.py, { stage: 0, item: "berry", born: w.t, hp: 5, maxHp: 5 });
  const first = Math.ceil((w.t + 1) / HOUR) * HOUR, end = w.t + 30 * DAY;
  // all of it: the sky, the wind and how far the day's air stands from its time of year's (forecast's warm)
  hooks.weather = (w) => { const h = hours[(w.t - first) / HOUR]; Object.assign(w.weather, { sky: h.sky, speed: h.speed, warm: h.warm }); };
  try {
    while (w.t < end && thingById(w, t.id)?.kind === "sapling") { w.t++; ecology(w); }
  } finally {
    hooks.weather = undefined;
  }
  // the hour it came up or withered, counted from the first it was tended; none if it did neither
  const now = thingById(w, t.id)?.kind;
  expect(now === "bush" ? { up: true, hours: (w.t - first) / HOUR } : now === undefined ? { up: false, hours: (w.t - first) / HOUR } : null).toEqual(fate);
});
