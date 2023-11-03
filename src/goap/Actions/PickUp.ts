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
      // log player positiong and thing poosition
      if (player && player.x === thing.x && player.y === thing.y) {
        return true;
      }
      return false;
    },

    perform(state: CombinedState) {
      state.quadtree.remove(thing);
      state.player.inventory.push(thing);
      return state;
    },
  };
}

export { PickUp };
