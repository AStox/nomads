"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getCraftableRecipes = void 0;
const Thing_1 = require("./Thing");
const World_1 = require("./World");
const Craft_1 = require("./goap/Actions/Craft");
const recipes = [
    {
        name: Thing_1.ThingType.AXE,
        ingredients: (state) => {
            if (state.player.inventory.filter((item) => item.type === Thing_1.ThingType.STICK).length >= 1 ||
                state.player.inventory.filter((item) => item.type === Thing_1.ThingType.STONE).length >= 1) {
                return true;
            }
            return false;
        },
        result: (state) => {
            const stick = state.player.inventory.find((item) => item.type === Thing_1.ThingType.STICK);
            if (stick) {
                state.player.inventory.splice(state.player.inventory.indexOf(stick), 1);
            }
            const stone = state.player.inventory.find((item) => item.type === Thing_1.ThingType.STONE);
            if (stone) {
                state.player.inventory.splice(state.player.inventory.indexOf(stone), 1);
            }
            const axe = (0, Thing_1.createThing)(Thing_1.ThingType.AXE);
            state.player.inventory.push(axe);
            return state;
        },
        actions: [Craft_1.Craft],
    },
    {
        name: Thing_1.ThingType.ROASTED_MUSHROOM,
        ingredients: (state) => {
            if (!state.player.inventory.some((item) => item.type === Thing_1.ThingType.MUSHROOM)) {
                return false;
            }
            const size = 2;
            const player = state.quadtree.queryAll().find((t) => t.id === state.player.id);
            const campfires = state.quadtree
                .query(new World_1.Rectangle(((player === null || player === void 0 ? void 0 : player.x) || 0) - size / 2, ((player === null || player === void 0 ? void 0 : player.y) || 0) - size / 2, size, size))
                .filter((thing) => thing.type === Thing_1.ThingType.CAMPFIRE);
            if (campfires.length === 0) {
                return false;
            }
            return true;
        },
        result: (state) => {
            const mushroom = state.player.inventory.find((item) => item.type === Thing_1.ThingType.MUSHROOM);
            if (mushroom) {
                state.player.inventory.splice(state.player.inventory.indexOf(mushroom), 1);
            }
            const roastedMushroom = (0, Thing_1.createThing)(Thing_1.ThingType.ROASTED_MUSHROOM);
            state.player.inventory.push(roastedMushroom);
            return state;
        },
        actions: [Craft_1.Craft],
    },
];
function getCraftableRecipes(state) {
    const craftableRecipes = recipes.filter((recipe) => recipe.ingredients(state));
    return craftableRecipes;
}
exports.getCraftableRecipes = getCraftableRecipes;
//# sourceMappingURL=Recipe.js.map