const { World, Rectangle } = require("./World");
const fs = require("fs");
const path = require("path");

describe("World", () => {
  let world;

  beforeEach(() => {
    world = new World(1000, 1000);
  });

  test("should populate items from config", () => {
    world.populateItemsFromConfig("src/configs/objects.json");

    const itemsInVision = world.quadtree.query(new Rectangle(0, 0, 100, 100));

    expect(itemsInVision.length).toBeGreaterThan(0);
    // expect a player to be in the world
    world.addItem({ symbol: "X", x: 0, y: 0 });
    expect(itemsInVision.some((item) => item.symbol === "X")).toBe(true);
  });
});
