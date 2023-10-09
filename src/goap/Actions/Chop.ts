import { CombinedState } from "../GOAPPlanner";
import { Thing, World } from "../../World";
import { Item } from "../../Items";
import { Action } from "../Action";
import { ThingType } from "../../Things";
import { WalkTo } from "./WalkTo";
import { PickUp } from "./PickUp";

function Chop(state: CombinedState, thing: Thing): Action {
  return {
    name: "Chop",
    target: thing,
    cost: 1,
    preconditions: { player: { x: thing.x, y: thing.y, inventory: [ThingType.AXE] } },
    effects: {
      toAdd: {
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
    },

    perform(): boolean {
      World.getInstance().addThing({
        id: "wood1",
        name: ThingType.WOOD,
        type: ThingType.WOOD,
        x: thing.x,
        y: thing.y,
        symbol: "🪵",
        actions: [WalkTo, PickUp],
      });
      return true;
      //   console.log("Picking up: ", thing);
      //   return state.player.pickUp(thing);
    },
  };
}

export { Chop };
