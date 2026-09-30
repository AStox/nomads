"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Heal = void 0;
const GOAPPlanner_1 = require("../GOAPPlanner");
function Heal(state, thing) {
    return {
        name: "Heal",
        target: thing,
        cost: 1 - thing.healing / 50,
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
            state.player.HP += thing.healing;
            const target = state.player.inventory.find((item) => item.type === thing.type);
            state.player.inventory = state.player.inventory.filter((item) => item.id !== target.id);
            return state;
        },
    };
}
exports.Heal = Heal;
//# sourceMappingURL=Heal.js.map