"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const Player_1 = require("../../Player");
const Thing_1 = require("../../Thing");
const QuadTree_1 = require("../../utils/QuadTree");
const StartFire_1 = require("./StartFire");
let state;
let wood;
let player;
beforeAll(() => {
    player = new Player_1.Player("1", "John Plant", 0, 0, "🧍", []);
    wood = (0, Thing_1.createThing)(Thing_1.ThingType.WOOD, { x: 0, y: 0 });
    let berry = (0, Thing_1.createThing)(Thing_1.ThingType.BERRY, { x: 0, y: 1 });
    state = createState([player, wood, berry]);
});
const createState = (things) => {
    return {
        quadtree: new QuadTree_1.QuadTree(new QuadTree_1.Rectangle(0, 0, 10, 10), 4),
        player: player,
    };
};
describe("StartFire", () => {
    it("should remove wood", () => {
        const action = (0, StartFire_1.StartFire)(state, wood);
        const newState = action.perform(state);
        // expect newState to no longer contain wood
        const quadtreeThings = newState.quadtree.queryAll();
        expect(quadtreeThings).not.toContain(wood);
    });
    it("should add a campfire", () => {
        const action = (0, StartFire_1.StartFire)(state, wood);
        const newState = action.perform(state);
        // expect newState to contain a campfire
        const quadtreeThings = newState.quadtree.queryAll();
        expect(quadtreeThings).toContainEqual(expect.objectContaining({
            type: Thing_1.ThingType.CAMPFIRE,
        }));
    });
    it("should not affect other objects", () => {
        const berry = (0, Thing_1.createThing)(Thing_1.ThingType.BERRY, { x: 0, y: 1 });
        state.quadtree.insert(berry);
        const action = (0, StartFire_1.StartFire)(state, wood);
        const newState = action.perform(state);
        const quadtreeThings = newState.quadtree.queryAll();
        expect(quadtreeThings).toContainEqual(expect.objectContaining({
            type: Thing_1.ThingType.BERRY,
        }));
    });
});
//# sourceMappingURL=StartFire.test.js.map