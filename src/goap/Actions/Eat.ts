import { CombinedState, GOAPPlanner } from "../GOAPPlanner";
import { Thing } from "../../World";
import { Action } from "../Action";
import { Food } from "../../Thing";
import logger from "../../utils/Logger";

function Eat(state: CombinedState, thing: Thing): Action {
  return {
    name: "Eat",
    target: thing,
    cost: 1 - (thing as Food).satiation / 50,
    actionFilter: (state: CombinedState) => {
      return GOAPPlanner.generateActions(state, []);
    },
    preconditions: (state: CombinedState) => {
      if (state.player.inventory.find((item) => item.type === thing.type)) {
        return true;
      }
      return false;
    },

    perform(state: CombinedState) {
      state.player.hunger += (thing as Food).satiation;
      const target = state.player.inventory.find((item) => item.type === thing.type) as Thing;
      state.player.inventory = state.player.inventory.filter((item) => item.id !== target.id);
      return state;
    },
  };
}

export { Eat };
