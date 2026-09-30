"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const World_1 = require("./World");
describe("World", () => {
    let world;
    beforeEach(() => {
        world = World_1.World.newWorld(1000, 1000);
    });
    // test("should populate things from config", () => {
    //   // world.populateThingsFromConfig("src/configs/objects.json");
    //   const thingsInVision = world.quadtree.query(new Rectangle(0, 0, 1000, 1000));
    //   expect(thingsInVision.length).toBeGreaterThan(0);
    // });
});
//# sourceMappingURL=World.test.js.map