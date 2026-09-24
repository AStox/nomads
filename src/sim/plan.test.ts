import { expect, test } from "bun:test";
import { plan } from "./plan";
import { RECIPES } from "./recipes";

const dist = { bush: 5, tree: 3, stick: 2, stone: 4, reeds: 3, clay: 6, water: 6, agent: 6 };
const empty = { inv: {}, at: null, flags: [] };
const ALL = RECIPES.map((r) => r.id);

test("an axe from nothing chains knapping, cord, and hafting", () => {
  const ops = plan(empty, "make:stone_axe", { dist, known: ["knap", "twist_cord", "stone_axe"], homeTier: 0 })!.map((s) => s.arg ?? s.op);
  expect(ops.at(-1)).toBe("stone_axe");
  expect(ops.indexOf("knap")).toBeLessThan(ops.indexOf("stone_axe"));
  expect(ops.indexOf("twist_cord")).toBeLessThan(ops.indexOf("stone_axe"));
});

test("you can't plan for something you don't know how to make", () => {
  expect(plan(empty, "make:stone_axe", { dist, known: ["knap"], homeTier: 0 })).toBeNull();
});

test("a worse home than the one you have isn't worth building", () => {
  expect(plan({ inv: { stick: 4, fiber: 2 }, at: null, flags: [] }, "make:lean_to", { dist, known: ALL, homeTier: 2 })).toBeNull();
});

test("warming up with no fire around means making one, if you know how", () => {
  const ops = plan(empty, "warm_up", { dist, known: ALL, homeTier: 0 })!.map((s) => s.arg ?? s.op);
  expect(ops).toContain("make_fire");
  expect(ops.at(-1)).toBe("warm_up");
});

test("a cabin from nothing gets a first step quickly", () => {
  const t0 = performance.now();
  const steps = plan(empty, "make:cabin", { dist, known: ALL, homeTier: 0 });
  expect(steps).not.toBeNull();
  expect(performance.now() - t0).toBeLessThan(300);
});
