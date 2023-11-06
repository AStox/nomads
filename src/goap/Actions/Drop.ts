import { CombinedState, GOAPPlanner } from "../GOAPPlanner";
import { Thing } from "../../World";
import { Action } from "../Action";

function Drop(state: CombinedState, thing: Thing): Action {
  return {
    name: "Drop",
    target: thing,
    cost: 2,
    actionFilter: (state: CombinedState) => {
      return GOAPPlanner.generateActions(state, []).filter(
        (action) => !(action.name === "WalkTo" && action.target.id === thing.id)
      );
    },
    preconditions: (state: CombinedState) => {
      if (state.player.inventory.find((item) => item.type === thing.type)) {
        return true;
      }
      return false;
    },

    perform(state: CombinedState) {
      const player = state.quadtree.queryAll().find((t) => t.id === state.player.id) as Thing;
      const target = state.player.inventory.find((item) => item.type === thing.type) as Thing;
      state.quadtree.insert({ ...target, x: player.x, y: player.y });
      state.player.inventory = state.player.inventory.filter((item) => item.id !== target.id);
      return state;
    },
  };
}

export { Drop };
