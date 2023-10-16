import { CombinedState } from "../GOAPPlanner";
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

    perform(state: CombinedState) {
      for (const ingredient of recipe.ingredients) {
        if (typeof ingredient === "object") {
          state.player.inventory = state.player.inventory.filter(
            (item) => item.id !== ingredient.id
          );
        } else {
          state.player.inventory = state.player.inventory.filter(
            (item) => item.type === ingredient
          );
        }
      }
      for (const result of recipe.result) {
        state.player.inventory.push(result);
      }
      return state;
    },
  };
}

export { Craft };
