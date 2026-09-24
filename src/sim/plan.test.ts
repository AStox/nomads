import { expect, test } from "bun:test";
import { plan } from "./plan";

const ctx = { dist: { bush: 5, tree: 3, stick: 2, stone: 4, agent: 6 }, hasHome: false };
const empty = { inv: {}, at: null, flags: [] };

test("shelter from nothing needs an axe, wood, and sticks first", () => {
  const ops = plan(empty, "build_shelter", ctx)!.map((s) => s.op);
  expect(ops.at(-1)).toBe("build_shelter");
  expect(ops.indexOf("craft_axe")).toBeLessThan(ops.indexOf("chop"));
  expect(ops.filter((o) => o === "chop").length).toBeGreaterThanOrEqual(2);
});

test("shelter plan is fast enough to run inside a tick", () => {
  const t0 = performance.now();
  plan(empty, "build_shelter", ctx);
  expect(performance.now() - t0).toBeLessThan(250);
});

test("giving with empty hands gathers something first, then walks to the person", () => {
  const steps = plan(empty, "give", ctx)!;
  expect(steps.length).toBe(4);
  expect(steps.slice(2)).toEqual([{ op: "goto", arg: "agent" }, { op: "social", arg: "give" }]);
});

test("no plan when a shelter already exists", () => {
  expect(plan(empty, "build_shelter", { ...ctx, hasHome: true })).toBeNull();
});
