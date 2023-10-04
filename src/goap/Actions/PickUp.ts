import { CombinedState } from "../GOAPPlanner";
import { Thing } from "../../World";
import { Item } from "../../Items";
import { Action } from "../Action";

function PickUp(state: CombinedState, item: Item): Action {
  return {
    name: "PickUp",
    cost: 1,
    preconditions: { x: item.x, y: item.y },
    effects: { inventory: [item] },

    perform(): boolean {
      console.log("Picking up: ", item);
      return state.player.pickUp(item.name);
    },
  };
}

export { PickUp };
