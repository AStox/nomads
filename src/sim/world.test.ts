import { expect, test } from "bun:test";
import { W, landing, mainland, newWorld } from "./world";
import { FAUNA } from "./fauna";

// Seeds 10 and 19 are thick with forest, with little open grass for herds; 22 and 24 have islets offshore.
test("everyone on a new island starts on the mainland, and whoever comes by sea lands there too", () => {
  for (const seed of [10, 19, 22, 24]) {
    const w = newWorld(seed), main = mainland(w);
    for (const b of [...w.agents, ...w.animals.filter((a) => FAUNA[a.species].ground)]) expect(main[b.y * W + b.x]).toBe(1);
    for (let i = 0; i < 50; i++) {
      const p = landing(w)!;
      expect(main[p.y * W + p.x]).toBe(1);
    }
  }
}, 120_000);
