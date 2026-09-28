import { expect, test } from "bun:test";
import { newWorld } from "./world";
import { record, watchers } from "./beliefs";
import type { Outcome } from "./physics";

test("a child who learns a new thing by watching isn't credited with inventing it", () => {
  const w = newWorld(3);
  const [maker, child] = w.agents;
  Object.assign(child, { x: maker.x, y: maker.y, px: maker.px, py: maker.py, born: w.t });
  const out: Outcome = {
    ok: true, text: "", uses: { stick: 1, fiber: 1 }, gives: { odd: 1 }, newKinds: ["odd"],
    fields: { verb: "join", inputs: ["fiber", "stick"], gives: ["odd"] },
  };
  record(w, maker, out, 10);
  watchers(w, maker, out, 10);
  expect(Object.keys(child.beliefs)).toHaveLength(1);
  expect(w.events.filter((e) => e.kind === "invent").map((e) => e.who)).toEqual([[maker.id]]);
});
