import { CombinedState } from "../GOAPPlanner";
import { Thing } from "../../World";
import { Action } from "../Action";
import { ThingType } from "../../Things";

function StartFire(state: CombinedState, thing: Thing): Action {
  return {
    name: "StartFire",
    target: thing,
    cost: 1,
    preconditions: { player: { inventory: [ThingType.WOOD, ThingType.WOOD] } },
    effects: { wood: -5, firemaking_xp: 5, nearby_fire: true },

    perform(): boolean {
      return true;
    },
  };
}

export { StartFire };
