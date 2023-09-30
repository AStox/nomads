import { World, Rectangle, Thing } from "./World";
import fs from "fs";
import path from "path";

describe("World", () => {
  let world: World;

  beforeEach(() => {
    world = new World(1000, 1000);
  });

  test("should populate things from config", () => {
    world.populateThingsFromConfig("src/configs/objects.json");

    const thingsInVision = world.quadtree.query(new Rectangle(0, 0, 100, 100));

    expect(thingsInVision.length).toBeGreaterThan(0);

    expect(thingsInVision.some((thing: Thing) => thing.symbol === "🧍")).toBe(true);
  });
});
