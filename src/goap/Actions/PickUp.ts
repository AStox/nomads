import { CombinedState, GOAPPlanner } from "../GOAPPlanner";
import { Thing } from "../../World";
import { Action } from "../Action";

function PickUp(state: CombinedState, thing: Thing): Action {
  return {
    name: "PickUp",
    target: thing,
    cost: 1,
    actionFilter: (state: CombinedState) => {
      return GOAPPlanner.generateActions(state, []).filter(
        (action) =>
          !(
            (action.name === "PickUp" && action.target.id === thing.id) ||
            (action.name === "WalkTo" && action.target.id === thing.id)
          )
      );
    },
    preconditions: (state: CombinedState) => {
      const player = state.quadtree.queryAll().find((t) => t.id === state.player.id);
      const target = state.quadtree
        .queryAll()
        .find((t) => t.type === thing.type && t.x === thing.x && t.y === thing.y);
      if (player && target && player.x === target.x && player.y === target.y) {
        return true;
      }
      return false;
    },

    perform(state: CombinedState) {
      const target = state.quadtree
        .queryAll()
        .find((t) => t.type === thing.type && t.x === thing.x && t.y === thing.y) as Thing;
      state.quadtree.remove(target);
      state.player.inventory.push(target);
      return state;
    },
  };
}

export { PickUp };
