import { Thing, ThingType, createThing } from "./Thing";
import { Rectangle, World } from "./World";
import { Craft } from "./goap/Actions/Craft";
import { CombinedState } from "./goap/GOAPPlanner";

interface Recipe {
  name: ThingType;
  ingredients: (state: CombinedState) => boolean;
  result: (state: CombinedState) => CombinedState;
  actions: Function[];
}

const recipes: Recipe[] = [
  {
    name: ThingType.AXE,
    ingredients: (state: CombinedState) => {
      if (
        state.player.inventory.filter((item) => item.type === ThingType.STICK).length >= 1 ||
        state.player.inventory.filter((item) => item.type === ThingType.STONE).length >= 1
      ) {
        return true;
      }
      return false;
    },
    result: (state: CombinedState) => {
      const stick = state.player.inventory.find((item) => item.type === ThingType.STICK);
      if (stick) {
        state.player.inventory.splice(state.player.inventory.indexOf(stick), 1);
      }
      const stone = state.player.inventory.find((item) => item.type === ThingType.STONE);
      if (stone) {
        state.player.inventory.splice(state.player.inventory.indexOf(stone), 1);
      }
      const axe = createThing(ThingType.AXE);
      state.player.inventory.push(axe);
      return state;
    },
    actions: [Craft],
  },
  {
    name: ThingType.ROASTED_MUSHROOM,
    ingredients: (state: CombinedState) => {
      if (!state.player.inventory.some((item) => item.type === ThingType.MUSHROOM)) {
        return false;
      }
      const size = 2;
      const campfires = state.quadtree
        .query(new Rectangle(state.player.x - size / 2, state.player.y - size / 2, size, size))
        .filter((thing) => thing.type === ThingType.CAMPFIRE);
      if (campfires.length === 0) {
        return false;
      }
      return true;
    },
    result: (state: CombinedState) => {
      const mushroom = state.player.inventory.find((item) => item.type === ThingType.MUSHROOM);
      if (mushroom) {
        state.player.inventory.splice(state.player.inventory.indexOf(mushroom), 1);
      }
      const roastedMushroom = createThing(ThingType.ROASTED_MUSHROOM);
      state.player.inventory.push(roastedMushroom);

      return state;
    },
    actions: [Craft],
  },
];

function getCraftableRecipes(state: CombinedState): Recipe[] {
  const craftableRecipes = recipes.filter((recipe) => recipe.ingredients(state));
  return craftableRecipes;
}

export { getCraftableRecipes, Recipe };
