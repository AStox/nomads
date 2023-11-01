import { CombinedState, GOAPPlanner } from "../GOAPPlanner";
import { Thing } from "../../World";
import { Action } from "../Action";

function Drop(state: CombinedState, thing: Thing): Action {
  return {
    name: "Drop",
    target: thing,
    cost: 1,
    actionFilter: (state: CombinedState) => {
      return GOAPPlanner.generateActions(state, []).filter(
        (action) => !(action.name === "WalkTo" && action.target.id === thing.id)
      );
    },
    preconditions: (state: CombinedState) => {
      if (state.player.inventory.find((item) => item.id === thing.id)) {
        return true;
      }
      return false;
    },

    perform(state: CombinedState) {
      const player = state.quadtree.queryAll().find((t) => t.id === state.player.id) as Thing;
      state.quadtree.insert({ ...thing, x: player.x, y: player.y });
      state.player.inventory = state.player.inventory.filter((item) => item.id !== thing.id);
      return state;
    },
  };
}

export { Drop };
