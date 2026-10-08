import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { BASE, ensure } from "./materials";
import { BURNS, COPPER, FIRED_CLAY, LEATHER, PHYS, POT_WALL, WOODS, mix, physOf, woodOf, type Burn, type Phys, type Row, type Wood } from "./fuel";
import { addThing, newWorld, type Agent, type Stack, type Thing, type World } from "./world";
import { applyRuling, dropStacks, giveItems, giveStack, hand, heat, join, place, shape, strikeTick, takeFromPile, type Outcome } from "./physics";
import { nearestThing, thingById } from "./space";
import { die } from "./life";
import { fallApart } from "./ecology";

// The tables of docs/research/fire-constants.md section 27, row by row, cells trimmed.
const DOC = readFileSync(new URL("../../docs/research/fire-constants.md", import.meta.url), "utf8").split("\n");
function table(heading: string): string[][] {
  const at = DOC.findIndex((l) => l.startsWith(heading));
  if (at < 0) throw new Error(`no ${heading} in the constants document`);
  const start = DOC.findIndex((l, i) => i > at && l.startsWith("|"));
  const rows: string[][] = [];
  for (let i = start + 2; DOC[i]?.startsWith("|"); i++) rows.push(DOC[i].split("|").slice(1, -1).map((c) => c.trim()));
  return rows;
}
// A number as the document writes it, to the places it writes: empty for none.
function same(actual: number | undefined, cell: string, what: string) {
  if (cell === "") return expect(actual, what).toBeUndefined();
  const places = cell.split(".")[1]?.length ?? 0;
  expect(actual, what).toBeDefined();
  expect(Math.abs(actual! - Number(cell)), `${what}: ${actual} against ${cell}`).toBeLessThanOrEqual(0.5 * 10 ** -places + 1e-9);
}
const burnsAs = (b: Burn | undefined, cell: string, what: string) => expect(b, what).toEqual(cell === "" ? undefined : BURNS[cell as Row]);

const setup = (): [World, Agent] => {
  const w = newWorld(42), a = w.agents[0];
  a.inv = [];
  return [w, a];
};
const made = (o: Outcome | "ask") => {
  if (o === "ask" || !o.ok) throw new Error("it should have made something");
  return Object.keys(o.gives)[0];
};

test("every raw material, wood and way of burning is what the constants document gives it", () => {
  for (const [row, tig, qcr, krc, flame, char, charYield, L] of table("### 27a.")) {
    const b = BURNS[row as Row];
    expect(b, row).toBeDefined();
    for (const [v, cell, f] of [[b.tig, tig, "tig"], [b.qcr, qcr, "qcr"], [b.krc, krc, "krc"], [b.flame, flame, "flame"], [b.char, char, "char"], [b.charYield, charYield, "charYield"], [b.L, L, "L"]] as const)
      same(v, cell, `${row} ${f}`);
  }
  expect(table("### 27a.").map((r) => r[0]).sort()).toEqual(Object.keys(BURNS).sort());
  for (const [species, G, green, heart, row] of table("### 27b.")) {
    const wood = WOODS[species as Wood | "generic"];
    same(wood.G, G, `${species} G`);
    same(wood.green, green, `${species} green`);
    same(wood.heart, heart, `${species} heartwood`);
    expect(wood.row, species).toBe(row as Row);
    const piece = woodOf(species as Wood | "generic", 0.02, 0.1);
    same(piece.rho, String(1000 * Number(G)), `${species} density`);
    burnsAs(piece.burn, row, species);
  }
  const kinds = table("### 27c.");
  expect(kinds.map((r) => r[0]).sort()).toEqual(Object.keys(BASE).sort());
  for (const [kind, rho, c, k, mmax, green, d, mass, burns] of kinds) {
    const x = PHYS[kind];
    for (const [v, cell, f] of [[x.rho, rho, "rho"], [x.c, c, "c"], [x.k, k, "k"], [x.mmax, mmax, "mmax"], [x.green, green, "green"], [x.d, d, "d"], [x.mass, mass, "mass"]] as const)
      same(v, cell, `${kind} ${f}`);
    burnsAs(x.burn, burns, kind);
  }
  const matter: Record<string, Partial<Phys>> = { "fired clay": FIRED_CLAY, copper: COPPER, leather: LEATHER };
  for (const [what, rho, c, k, mmax, d, mass, burns] of table("### 27d.")) {
    if (what === "a pot") { same(POT_WALL, d, "a pot's wall"); continue; }
    const x = matter[what];
    for (const [v, cell, f] of [[x.rho, rho, "rho"], [x.c, c, "c"], [x.k, k, "k"], [x.mmax, mmax, "mmax"]] as const) same(v, cell, `${what} ${f}`);
    if (d !== "as made from") { same(x.d, d, `${what} d`); same(x.mass, mass, `${what} mass`); }
    burnsAs(x.burn, burns, what);
  }
});

test("a stone is dense and thick but nothing in it burns, and a joined thing burns only by the share of it that does", () => {
  expect(PHYS.stone.burn).toBeUndefined();
  expect(PHYS.stone.rho).toBeGreaterThan(2000);
  expect(PHYS.stone.d).toBeGreaterThan(0);
  const [w, a] = setup();
  giveItems(w, a, "fiber", 4);
  const cord = made(join(w, a, { verb: "join", items: ["fiber", "fiber"] }));
  const twisted = physOf(w.kinds, w.kinds[cord])!;
  // two fibers twisted together are fiber, twice as much of it
  for (const f of ["rho", "c", "k", "mmax", "d"] as const) expect(twisted[f]).toBeCloseTo(PHYS.fiber[f], 9);
  expect(twisted.mass).toBeCloseTo(2 * PHYS.fiber.mass, 9);
  for (const f of Object.keys(BURNS.fine) as (keyof Burn)[]) expect(twisted.burn![f]).toBeCloseTo(PHYS.fiber.burn![f], 9);
  giveItems(w, a, "stick");
  giveItems(w, a, "sharp_stone");
  const axe = physOf(w.kinds, w.kinds[made(join(w, a, { verb: "join", items: ["sharp_stone", "stick", cord] }))])!;
  const parts = [PHYS.sharp_stone, PHYS.stick, twisted], mass = parts.reduce((t, x) => t + x.mass, 0);
  expect(axe.mass).toBeCloseTo(mass, 9);
  expect(axe.c).toBeCloseTo(parts.reduce((t, x) => t + x.c * x.mass, 0) / mass, 9);
  expect(axe.rho).toBeCloseTo(mass / parts.reduce((t, x) => t + x.mass / x.rho, 0), 9);
  // as thick as its thickest part, the stick
  expect(axe.d).toBe(PHYS.stick.d);
  // the stone's share doesn't burn, and the wood and the cord light as wood and fiber do, by their shares
  expect(axe.burn!.share).toBeCloseTo((PHYS.stick.mass + twisted.mass) / mass, 9);
  expect(axe.burn!.tig).toBeCloseTo((PHYS.stick.mass * 350 + twisted.mass * 250) / (PHYS.stick.mass + twisted.mass), 9);
});

test("making new matter: clay fired in a pot's shape, a stew of what's in the pot, copper whose conductivity no rounding touches", () => {
  const [w, a] = setup();
  addThing(w, "fire", a.px, a.py, { hp: 400, maxHp: 400 });
  giveItems(w, a, "stone", 3);
  place(w, a, { verb: "place", items: ["stone", "stone", "stone"] });
  giveItems(w, a, "clay");
  const bowl = made(shape(w, a, { verb: "shape", items: ["clay"], shape: "bowl" }));
  const fired = physOf(w.kinds, w.kinds[made(heat(w, a, { verb: "heat", items: [bowl] }))])!;
  expect(fired).toEqual({ ...FIRED_CLAY, d: POT_WALL, mass: PHYS.clay.mass });
  const pot = Object.keys(w.kinds).find((k) => k.startsWith("fired:"))!;
  giveItems(w, a, "meat");
  const stew = physOf(w.kinds, w.kinds[made(heat(w, a, { verb: "heat", items: [pot, "meat"] }))])!;
  expect(stew).toEqual(mix([PHYS.meat])!);
  const [lump] = ensure(w.kinds, "smelt:test", () => ({ name: "metal lump", props: { metal: 1 }, parts: ["ore"], phys: COPPER }));
  expect(physOf(w.kinds, lump)!.k).toBe(401);
});

test("a world saved before records were kept reads raw materials by their base and made things by their parts, and a law takes its inputs'", () => {
  const [w, a] = setup();
  giveItems(w, a, "fiber", 2);
  const cord = made(join(w, a, { verb: "join", items: ["fiber", "fiber"] }));
  // as an old save holds them: no records anywhere
  const saved = JSON.parse(JSON.stringify(w.kinds));
  delete saved[cord].phys;
  expect(physOf(saved, saved.stick)).toEqual(PHYS.stick);
  expect(physOf(saved, saved[cord])).toEqual(mix([PHYS.fiber, PHYS.fiber]));
  giveItems(w, a, "stone");
  giveItems(w, a, "bone");
  const out = applyRuling(w, a, { verb: "join", items: ["stone", "bone"] }, "join|bone+stone", { useful: true, name: "knob", props: { hard: 0.7 } });
  expect(physOf(w.kinds, w.kinds[made(out)])).toEqual(mix([PHYS.bone, PHYS.stone]));
});

// ---------- pieces ----------
const grown = (w: World, a: Agent) => { a.born = w.t - 1e6; return a; };
const stick = (w: World, d: number, species = "ash"): Stack => ({ k: "stick", hp: 1, born: w.t, size: { d, len: 1.2, mass: (Math.PI / 4) * d * d * 1.2 * 570 }, species });
const pileOf = (w: World, at: { px: number; py: number }, k: string) => nearestThing(w, at.px, at.py, ["item"], (t) => t.item === k, 3)!;

test("felling a 15 m oak gives logs as thick as an oak's trunk, and branches thicker than a berry bush's stems", () => {
  const [w, a] = setup();
  grown(w, a);
  w.kinds.axe = { id: "axe", name: "axe", props: { sharp: 0.9, heavy: 0.8, hard: 0.9, long: 0.8, toughness: 1 } };
  giveItems(w, a, "axe");
  const fell = (t: Thing) => { const st = { progress: 0 }; for (let i = 0; i < 500 && !strikeTick(w, a, { verb: "strike", items: [], tool: "axe", target: { kind: t.kind, thing: t.id } }, st).done; i++); };
  fell(addThing(w, "tree", a.px, a.py, { species: "oak", size: 15 }));
  const logs = a.inv.filter((s) => s.k === "log"), branches = a.inv.filter((s) => s.k === "stick");
  expect(logs.length).toBe(2);
  // sec. 19a: a forest oak 15 m tall stands on a trunk 18.1 cm across
  for (const s of logs) { expect(s.species).toBe("oak"); expect(s.size!.d).toBeCloseTo(0.181, 3); }
  a.inv = a.inv.filter((s) => s.k === "axe");
  fell(addThing(w, "bush", a.px, a.py, { species: "berry", size: 1.5 }));
  const stem = a.inv.find((s) => s.k === "stick")!;
  expect(stem.species).toBe("berry");
  expect(branches.length).toBe(2);
  for (const s of branches) expect(s.size!.d).toBeGreaterThan(stem.size!.d);
});

test("a piece of wood keeps its size and species handed over, handed back, taken, dropped at a death and picked up again", () => {
  const [w, a] = setup();
  const b = w.agents[1];
  b.inv = [];
  const piece = stick(w, 0.021);
  const held = (x: Agent) => x.inv.find((s) => s.k === "stick");
  giveStack(w, a, { ...piece });
  expect(hand(w, a, b, "stick")).toBe(1);
  expect(held(b)).toEqual(piece);
  hand(w, b, a, "stick");
  expect(held(a)).toEqual(piece);
  hand(w, a, b, "stick");
  die(w, b, "cold");
  expect(takeFromPile(w, pileOf(w, b, "stick"), 0)).toEqual(piece);
});

test("sticks of two thicknesses set down together lie in one pile as two pieces and come up as they were; a full hand sets a piece down whole", () => {
  const [w, a] = setup();
  grown(w, a);
  const thin = stick(w, 0.008), thick = stick(w, 0.03, "pine");
  dropStacks(w, a.px, a.py, [thin, thick]);
  const pile = pileOf(w, a, "stick");
  expect(pile.n).toBe(2);
  expect([takeFromPile(w, pile, 0), takeFromPile(w, pile, 0)].sort((x, y) => x.size!.d - y.size!.d)).toEqual([thin, thick]);
  // one each of sixteen things, none of them spare
  for (const k of ["stone", "sharp_stone", "fiber", "clay", "log", "plank", "bark", "resin", "flint", "flint_blade", "charcoal", "ore", "pebble", "fern", "bone", "bone_shard"]) giveItems(w, a, k);
  expect(giveStack(w, a, { ...thick })).toBe(false);
  expect(pileOf(w, a, "stick").pieces).toEqual([thick]);
});

test("a shelter of sticks keeps its pieces, and when it falls apart they fall as they were laid", () => {
  const [w, a] = setup();
  const sticks = Array.from({ length: 5 }, (_, i) => stick(w, 0.01 + i * 0.002, "pine"));
  for (const s of sticks) giveStack(w, a, { ...s });
  giveItems(w, a, "fiber", 3);
  expect(place(w, a, { verb: "place", items: [...Array(5).fill("stick"), "fiber", "fiber", "fiber"] }).builds).toBe("shelter");
  const home = thingById(w, a.home)!;
  expect(home.pieces).toEqual(sticks);
  // every kind it was built of falls this time, half of each
  const random = Math.random;
  Math.random = () => 0;
  try { fallApart(w, home); } finally { Math.random = random; }
  expect(pileOf(w, home, "stick").pieces).toEqual(sticks.slice(0, 3));
});

test("what's made of one piece of wood is that piece: a brand lit from it, and the charcoal it smothers into", () => {
  const [w, a] = setup();
  const fire = addThing(w, "fire", a.px, a.py, { hp: 400, maxHp: 400 });
  const piece = stick(w, 0.018, "hazel");
  giveStack(w, a, { ...piece });
  const lit = made(heat(w, a, { verb: "heat", items: ["stick"] })), brand = a.inv.find((s) => s.k === lit)!;
  expect([brand.size, brand.species]).toEqual([piece.size, "hazel"]);
  // heaped over with stone, the fire smothers a log into charcoal: two lumps, as thick as the log, sharing its char
  giveItems(w, a, "stone", 6);
  place(w, a, { verb: "place", items: ["stone", "stone", "stone"] });
  place(w, a, { verb: "place", items: ["stone", "stone", "stone"] });
  expect(fire.covered).toBe(true);
  const log: Stack = { k: "log", hp: 1, born: w.t, size: { d: 0.15, len: 1, mass: 8 }, species: "oak" };
  giveStack(w, a, { ...log });
  heat(w, a, { verb: "heat", items: ["log"] });
  const lumps = a.inv.filter((s) => s.k === "charcoal");
  expect(lumps.length).toBe(2);
  for (const s of lumps) expect(s).toEqual({ k: "charcoal", hp: 1, born: w.t, size: { d: 0.15, len: 0.5, mass: (8 * BURNS.hardwood.charYield) / 2 }, species: "oak" });
});
