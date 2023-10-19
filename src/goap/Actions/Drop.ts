import { CombinedState } from "../GOAPPlanner";
import { Thing } from "../../World";
import { Action } from "../Action";

function Drop(state: CombinedState, thing: Thing): Action {
  return {
    name: "Drop",
    target: thing,
    cost: 1,
    preconditions: { player: { inventory: [thing] } },

    perform(state: CombinedState) {
      state.things.push({ ...thing, x: state.player.x, y: state.player.y });
      state.player.inventory = state.player.inventory.filter((item) => item.id !== thing.id);
      return state;
    },
  };
}

export { Drop };
