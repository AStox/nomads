"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Chop = void 0;
const GOAPPlanner_1 = require("../GOAPPlanner");
const Thing_1 = require("../../Thing");
function Chop(state, thing) {
    return {
        name: "Chop",
        target: thing,
        cost: 1,
        actionFilter: (state) => {
            return GOAPPlanner_1.GOAPPlanner.generateActions(state, []);
        },
        preconditions: (state) => {
            const player = state.quadtree.queryAll().find((t) => t.id === state.player.id);
            const target = state.quadtree
                .queryAll()
                .find((t) => t.type === thing.type && t.x === thing.x && t.y === thing.y);
            if (player &&
                target &&
                player.x === target.x &&
                player.y === target.y &&
                state.player.inventory.find((item) => item.type === Thing_1.ThingType.AXE)) {
                return true;
            }
            return false;
        },
        perform(state) {
            state.quadtree.insert((0, Thing_1.createThing)(Thing_1.ThingType.WOOD, { x: thing.x, y: thing.y }));
            const target = state.quadtree
                .queryAll()
                .find((t) => t.type === thing.type && t.x === thing.x && t.y === thing.y);
            state.quadtree.remove(target);
            return state;
        },
    };
}
exports.Chop = Chop;
//# sourceMappingURL=Chop.js.map