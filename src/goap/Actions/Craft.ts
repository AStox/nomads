import { CombinedState } from "../GOAPPlanner";
import { Thing, World } from "../../World";
import { Action } from "../Action";
import { Recipe } from "../../Recipe";

function Craft(state: CombinedState, recipe: Recipe): Action {
  return {
    name: "Craft",
    target: recipe.result[0],
    cost: 1,
    preconditions: { player: { inventory: [...recipe.ingredients] } },
    effects: {
      toAdd: {
        player: { inventory: [...recipe.result] },
      },
      toRemove: {
        player: { inventory: [...recipe.ingredients] },
      },
    },

    perform(): boolean {
      return true;
    },
  };
}

export { Craft };
