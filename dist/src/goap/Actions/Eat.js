"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Eat = void 0;
const GOAPPlanner_1 = require("../GOAPPlanner");
function Eat(state, thing) {
    return {
        name: "Eat",
        target: thing,
        cost: 1 - thing.satiation / 50,
        actionFilter: (state) => {
            return GOAPPlanner_1.GOAPPlanner.generateActions(state, []);
        },
        preconditions: (state) => {
            if (state.player.inventory.find((item) => item.type === thing.type)) {
                return true;
            }
            return false;
        },
        perform(state) {
            state.player.hunger += thing.satiation;
            const target = state.player.inventory.find((item) => item.type === thing.type);
            state.player.inventory = state.player.inventory.filter((item) => item.id !== target.id);
            return state;
        },
    };
}
exports.Eat = Eat;
//# sourceMappingURL=Eat.js.map