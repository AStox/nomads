import { expect, test } from "bun:test";
import { W, landing, mainland, newWorld } from "./world";
import { FAUNA } from "./fauna";

// The Bornholm generator makes one stretch of ground; seed 10's has a tile of it cut off from the rest, which is where no
// one may start or land. One island is the claim's whole test, and growing it is most of the test's time.
test("everyone on a new island starts on the mainland, and whoever comes by sea lands there too", () => {
  const w = newWorld(10), main = mainland(w);
  for (const b of [...w.agents, ...w.animals.filter((a) => FAUNA[a.species].ground)]) expect(main[b.y * W + b.x]).toBe(1);
  // arrivals at fifty different times, each on the bearing the world's stream gives that tick; the same tick lands the
  // same place again, so a seeded run replays
  for (let i = 0; i < 50; i++) {
    w.t = i * 97;
    const p = landing(w)!;
    expect(main[p.y * W + p.x]).toBe(1);
    if (i === 0) expect(landing(w)).toEqual(p);
  }
}, 120_000);
