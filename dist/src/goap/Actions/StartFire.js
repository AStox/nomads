"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.StartFire = void 0;
const GOAPPlanner_1 = require("../GOAPPlanner");
const Thing_1 = require("../../Thing");
function StartFire(state, thing) {
    return {
        name: "StartFire",
        target: thing,
        cost: 1,
        actionFilter: (state) => {
            return GOAPPlanner_1.GOAPPlanner.generateActions(state, []);
        },
        preconditions: (state) => {
            const player = state.quadtree.queryAll().find((t) => t.id === state.player.id);
            const wood = state.quadtree
                .queryAll()
                .find((t) => t.type === thing.type && t.x === thing.x && t.y === thing.y);
            if (player && wood && player.x === wood.x && player.y === wood.y) {
                return true;
            }
            return false;
        },
        perform(state) {
            state.quadtree.insert((0, Thing_1.createThing)(Thing_1.ThingType.CAMPFIRE, { x: thing.x, y: thing.y }));
            const wood = state.quadtree
                .queryAll()
                .find((t) => t.type === thing.type && t.x === thing.x && t.y === thing.y);
            state.quadtree.remove(wood);
            return state;
        },
    };
}
exports.StartFire = StartFire;
//# sourceMappingURL=StartFire.js.map