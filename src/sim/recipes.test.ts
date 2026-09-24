import { expect, test } from "bun:test";
import { RECIPES, signature } from "./recipes";
import { GATHER_OP } from "./plan";

test("no two recipes can be triggered by the same tinkering attempt", () => {
  const keys = RECIPES.map((r) => `${signature(r)}@${r.near ?? ""}`);
  expect(new Set(keys).size).toBe(keys.length);
});

test("every ingredient and tool can be gathered or made", () => {
  const obtainable = new Set<string>([...Object.values(GATHER_OP).map((g) => g.item), ...RECIPES.flatMap((r) => (r.makes.item ? [r.makes.item] : []))]);
  for (const r of RECIPES) for (const i of [...Object.keys(r.inputs), ...(r.tools ?? [])]) expect(obtainable.has(i)).toBe(true);
});
