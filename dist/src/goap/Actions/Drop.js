"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Drop = void 0;
const GOAPPlanner_1 = require("../GOAPPlanner");
function Drop(state, thing) {
    return {
        name: "Drop",
        target: thing,
        cost: 2,
        actionFilter: (state) => {
            return GOAPPlanner_1.GOAPPlanner.generateActions(state, []).filter((action) => !(action.name === "WalkTo" && action.target.id === thing.id));
        },
        preconditions: (state) => {
            if (state.player.inventory.find((item) => item.type === thing.type)) {
                return true;
            }
            return false;
        },
        perform(state) {
            const player = state.quadtree.queryAll().find((t) => t.id === state.player.id);
            const target = state.player.inventory.find((item) => item.type === thing.type);
            state.quadtree.insert(Object.assign(Object.assign({}, target), { x: player.x, y: player.y }));
            state.player.inventory = state.player.inventory.filter((item) => item.id !== target.id);
            return state;
        },
    };
}
exports.Drop = Drop;
//# sourceMappingURL=Drop.js.map