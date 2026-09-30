"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Craft = void 0;
const GOAPPlanner_1 = require("../GOAPPlanner");
const Thing_1 = require("../../Thing");
function Craft(state, recipe) {
    return {
        name: "Craft",
        target: (0, Thing_1.createThing)(recipe.name),
        cost: 1,
        actionFilter: (state) => {
            return GOAPPlanner_1.GOAPPlanner.generateActions(state, []);
        },
        preconditions: (state) => {
            return recipe.ingredients(state);
        },
        perform(state) {
            return recipe.result(state);
        },
    };
}
exports.Craft = Craft;
//# sourceMappingURL=Craft.js.map