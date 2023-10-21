import { CombinedState } from "../GOAPPlanner";
import { Thing } from "../../World";
import { Action } from "../Action";

function PickUp(state: CombinedState, thing: Thing): Action {
  return {
    name: "PickUp",
    target: thing,
    cost: 1,
    preconditions: { player: { x: thing.x, y: thing.y } },

    perform(state: CombinedState) {
      state.things = state.things.filter((t) => t.id === thing.id);
      state.quadtree.remove(thing);
      state.player.inventory.push(thing);
      return state;
    },
  };
}

export { PickUp };
