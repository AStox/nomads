import { expect, test } from "bun:test";
import { addThing, newWorld, type Act, type Agent, type Thing, type World } from "./world";
import { count, fireHeat, giveItems, heat, join, place, strikeTick, type Outcome } from "./physics";

const setup = (): [World, Agent, Thing] => {
  const w = newWorld(42);
  const a = w.agents[0];
  a.inv = [];
  return [w, a, addThing(w, "fire", a.x, a.y, { hp: 400, maxHp: 400 })];
};
const heated = (w: World, a: Agent, act: Omit<Act, "verb">): Outcome => {
  const r = heat(w, a, { verb: "heat", ...act });
  if (r === "ask") throw new Error("the heat rules should cover this");
  return r;
};
const put = (w: World, a: Agent, k: string, n: number) => { giveItems(w, a, k, n); return place(w, a, { verb: "place", items: Array(n).fill(k) }); };
const hammer = (w: World, a: Agent, tool: string, target: string) => {
  const st = { progress: 0 };
  let r;
  do r = strikeTick(w, a, { verb: "strike", items: [], tool, target: { kind: target } }, st); while (!r.done);
  return r.out!;
};

test("clay only hardens in a ringed fire, and ore only gives up metal to ringed charcoal with air blown in", () => {
  const [w, a, fire] = setup();
  giveItems(w, a, "clay");
  expect(heated(w, a, { items: ["clay"] }).effect).toBe("too_cool");
  expect(count(a, "clay")).toBe(1);
  put(w, a, "stone", 3);
  expect(fireHeat(w, fire)).toBe(1.3);
  const pot = heated(w, a, { items: ["clay"] });
  expect(pot.ok).toBe(true);
  expect(pot.fields.at).toBe("hearth");
  giveItems(w, a, "ore");
  expect(heated(w, a, { items: ["ore"] }).ok).toBe(false);
  expect(put(w, a, "charcoal", 2).builds).toBe("forge");
  expect(fireHeat(w, fire)).toBe(2);
  expect(heated(w, a, { items: ["ore"] }).effect).toBe("too_cool");
  giveItems(w, a, "fiber", 3);
  const mat = join(w, a, { verb: "join", items: ["fiber", "fiber", "fiber"] });
  if (mat === "ask") throw new Error();
  const lump = heated(w, a, { items: ["ore"], tool: Object.keys(mat.gives)[0] });
  expect(lump.ok).toBe(true);
  expect(w.kinds[Object.keys(lump.gives)[0]].props.metal).toBe(1);
});

test("wood burns in an open fire but turns to charcoal once the ringed fire is heaped over", () => {
  const [w, a, fire] = setup();
  put(w, a, "stone", 3);
  giveItems(w, a, "log");
  expect(Object.keys(heated(w, a, { items: ["log"] }).gives)[0]).toBe("burning:log");
  expect(put(w, a, "stone", 3).builds).toBe("kiln");
  expect(fire.covered).toBe(true);
  giveItems(w, a, "log");
  expect(heated(w, a, { items: ["log"] }).gives).toEqual({ charcoal: 2 });
});

test("hammering hot metal at a charcoal fire draws out a blade sharper and tougher than flint; cold metal only dents", () => {
  const [w, a] = setup();
  put(w, a, "stone", 3);
  put(w, a, "charcoal", 3);
  w.kinds.lump = { id: "lump", name: "metal lump", props: { hard: 0.8, heavy: 0.85, metal: 1, toughness: 0.85 }, parts: ["ore"], verb: "heat" };
  giveItems(w, a, "stone", 2); giveItems(w, a, "sharp_stone"); giveItems(w, a, "lump", 2);
  expect(hammer(w, a, "stone", "lump").effect).toBe("dented");
  const blade = (tool: string) => {
    const hot = Object.keys(heated(w, a, { items: ["lump"] }).gives)[0];
    const out = hammer(w, a, tool, hot);
    expect(out.ok).toBe(true);
    return w.kinds[Object.keys(out.gives)[0]].props;
  };
  const heavy = blade("stone"), light = blade("sharp_stone");
  expect(heavy.sharp!).toBeGreaterThan(w.kinds.flint_blade.props.sharp!);
  expect(heavy.toughness!).toBeGreaterThan(w.kinds.flint_blade.props.toughness! + 0.3);
  expect(light.sharp!).toBeLessThan(heavy.sharp!);
});

test("hands full of tools still make room for food", () => {
  const [w, a] = setup();
  a.born = w.t - 1e6;
  giveItems(w, a, "sharp_stone", 11);
  for (const k of ["stick", "clay", "stone", "fiber", "bone"]) giveItems(w, a, k);
  expect(a.inv.length).toBe(16);
  expect(giveItems(w, a, "berry", 3)).toBe(3);
  expect(count(a, "berry")).toBe(3);
  expect(count(a, "sharp_stone")).toBe(8);
});
