import { World, Rectangle, Thing } from "./World";

describe("World", () => {
  let world: World;

  beforeEach(() => {
    world = new World(1000, 1000);
  });

  test("should populate things from config", () => {
    world.populateThingsFromConfig("src/configs/objects.json");

    const thingsInVision = world.quadtree.query(new Rectangle(0, 0, 1000, 1000));

    expect(thingsInVision.length).toBeGreaterThan(0);
  });
});
