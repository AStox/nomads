"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PickUp = void 0;
const GOAPPlanner_1 = require("../GOAPPlanner");
function PickUp(state, thing) {
    return {
        name: "PickUp",
        target: thing,
        cost: 1,
        actionFilter: (state) => {
            return GOAPPlanner_1.GOAPPlanner.generateActions(state, []).filter((action) => !((action.name === "PickUp" && action.target.id === thing.id) ||
                (action.name === "WalkTo" && action.target.id === thing.id)));
        },
        preconditions: (state) => {
            const player = state.quadtree.queryAll().find((t) => t.id === state.player.id);
            const target = state.quadtree
                .queryAll()
                .find((t) => t.type === thing.type && t.x === thing.x && t.y === thing.y);
            if (player && target && player.x === target.x && player.y === target.y) {
                return true;
            }
            return false;
        },
        perform(state) {
            const target = state.quadtree
                .queryAll()
                .find((t) => t.type === thing.type && t.x === thing.x && t.y === thing.y);
            state.quadtree.remove(target);
            state.player.inventory.push(target);
            return state;
        },
    };
}
exports.PickUp = PickUp;
//# sourceMappingURL=PickUp.js.map