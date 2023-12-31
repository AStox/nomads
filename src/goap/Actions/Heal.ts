import { CombinedState, GOAPPlanner } from "../GOAPPlanner";
import { Thing } from "../../World";
import { Action } from "../Action";
import { Food, Healable } from "../../Thing";

function Heal(state: CombinedState, thing: Thing): Action {
  return {
    name: "Heal",
    target: thing,
    cost: 1 - (thing as Healable).healing / 50,
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
      state.player.HP += (thing as Healable).healing;
      const target = state.player.inventory.find((item) => item.type === thing.type) as Thing;
      state.player.inventory = state.player.inventory.filter((item) => item.id !== target.id);
      return state;
    },
  };
}

export { Heal };
