import { CombinedState } from "../GOAPPlanner";
import { Thing } from "../../World";
import { Action } from "../Action";

function StartFire(): Action {
  return {
    name: "StartFire",
    cost: 1,
    preconditions: { wood: 5 },
    effects: { wood: -5, firemaking_xp: 5, nearby_fire: true },

    perform(): boolean {
      return true;
    },
  };
}

export { StartFire };
