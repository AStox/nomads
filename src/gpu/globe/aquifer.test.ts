// The identity-defined colouring a global relaxation of the water table is ordered by (aquifer.ts): no two neighbouring cells of the cube-sphere, across tile and face edges and at the
// cube's corners, share a colour, and few cells are in the late colours.
import { describe, expect, test } from "bun:test";
import { FACES, tierGrid } from "./grid";
import { colouring, neighbours4 } from "./aquifer";

describe("the aquifer's colouring", () => {
  for (const tier of [0, 1]) {
    test(`tier ${tier}: a proper colouring of the 4-neighbour graph, the late colours few`, () => {
      const c = colouring(tier), N = FACES * tierGrid(tier).fn ** 2;
      let same = 0, late = 0;
      for (let id = 0; id < N; id++) {
        if (c[id] >= 2) late++;
        for (const j of neighbours4(tier, id)) if (c[j] === c[id]) same++;
      }
      expect(same).toBe(0);
      expect(late).toBe(4 * tierGrid(tier).fn);
    });
  }
});
