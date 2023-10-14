import { CombinedState } from "../GOAPPlanner";
import { Thing } from "../../World";
import { Item } from "../../Items";
import { Action } from "../Action";

function Drop(state: CombinedState, thing: Thing): Action {
  return {
    name: "Drop",
    target: thing,
    cost: 1,
    preconditions: { player: { inventory: [thing] } },
    effects: {
      toAdd: { things: [{ ...thing, x: state.player.x, y: state.player.y }] },
      toRemove: { player: { inventory: [thing] } },
    },

    perform(): boolean {
      console.log("Dropping: ", thing);
      return state.player.drop(thing);
    },
  };
}

export { Drop };
