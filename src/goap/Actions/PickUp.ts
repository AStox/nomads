import { CombinedState } from "../GOAPPlanner";
import { Thing } from "../../World";
import { Item } from "../../Items";
import { Action } from "../Action";

function PickUp(state: CombinedState, thing: Thing): Action {
  return {
    name: "PickUp",
    cost: 1,
    preconditions: { player: { x: thing.x, y: thing.y } },
    effects: { player: { inventory: { [thing.name]: thing } } },

    perform(): boolean {
      console.log("Picking up: ", thing);
      return state.player.pickUp(thing);
    },
  };
}

export { PickUp };
