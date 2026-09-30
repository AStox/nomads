"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WalkTo = void 0;
const GOAPPlanner_1 = require("../GOAPPlanner");
function WalkTo(state, thing) {
    return {
        name: "WalkTo",
        target: thing,
        cost: 1,
        actionFilter: (state) => {
            return GOAPPlanner_1.GOAPPlanner.generateActions(state, []).filter((action) => action.name !== "WalkTo");
        },
        preconditions: (state) => {
            return true;
        },
        simulate(state) {
            let player = state.quadtree.queryAll().find((t) => t.id === state.player.id);
            if (player) {
                state.quadtree.remove(player);
                state.quadtree.insert(Object.assign(Object.assign({}, state.player), { x: thing.x, y: thing.y }));
            }
            return state;
        },
        perform(state) {
            // return state.player.moveTo(newPlayerPosition.x, newPlayerPosition.y);
            // state.player.x = destination.x;
            // state.player.y = destination.y;
            let player = state.quadtree.queryAll().find((t) => t.id === state.player.id);
            if (player) {
                const destination = { x: thing.x, y: thing.y };
                let newPlayerPosition = { x: player.x, y: player.y };
                if (destination.x !== undefined && destination.y !== undefined) {
                    const dx = destination.x - player.x;
                    const dy = destination.y - player.y;
                    const length = Math.sqrt(dx * dx + dy * dy);
                    const speed = state.player.speed;
                    if (length > speed) {
                        const normalizedVector = {
                            dx: dx / length,
                            dy: dy / length,
                        };
                        newPlayerPosition = {
                            x: player.x + normalizedVector.dx * speed,
                            y: player.y + normalizedVector.dy * speed,
                        };
                    }
                    else {
                        newPlayerPosition = { x: thing.x, y: thing.y };
                    }
                }
                state.quadtree.remove(player);
                state.quadtree.insert(Object.assign(Object.assign({}, state.player), { x: newPlayerPosition.x, y: newPlayerPosition.y }));
            }
            return state;
        },
    };
}
exports.WalkTo = WalkTo;
//# sourceMappingURL=WalkTo.js.map