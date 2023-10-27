import { CombinedState, GOAPPlanner } from "../GOAPPlanner";
import { Action } from "../Action";
import { Recipe } from "../../Recipe";
import { createThing } from "../../Thing";

function Craft(state: CombinedState, recipe: Recipe): Action {
  return {
    name: "Craft",
    target: createThing(recipe.name), // TODO: This needs to not require a thing, but rather just a ThingType
    cost: 1,
    actionFilter: (state: CombinedState) => {
      return GOAPPlanner.generateActions(state, []);
    },
    preconditions: (state: CombinedState) => {
      return recipe.ingredients(state);
    },

    perform(state: CombinedState) {
      return recipe.result(state);
    },
  };
}

export { Craft };
