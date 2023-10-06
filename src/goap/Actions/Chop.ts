import { CombinedState } from "../GOAPPlanner";
import { Thing } from "../../World";
import { Item } from "../../Items";
import { Action } from "../Action";
import { ThingType } from "../../Things";
import { WalkTo } from "./WalkTo";
import { PickUp } from "./PickUp";

function Chop(state: CombinedState, thing: Thing): Action {
  return {
    name: "Chop",
    cost: 1,
    preconditions: { player: { x: thing.x, y: thing.y, inventory: [ThingType.AXE] } },
    effects: {
      things: [
        {
          name: ThingType.WOOD,
          type: ThingType.WOOD,
          x: thing.x,
          y: thing.y,
          symbol: "🪵",
          actions: [WalkTo, PickUp],
        },
      ],
    },

    perform(): boolean {
      console.log("Picking up: ", thing);
      return state.player.pickUp(thing);
    },
  };
}

export { Chop };
