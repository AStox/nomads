import { CombinedState } from "../GOAPPlanner";
import { Thing } from "../../World";
import { Action } from "../Action";
import { ThingType } from "../../Thing";

function StartFire(state: CombinedState, thing: Thing): Action {
  return {
    name: "StartFire",
    target: thing,
    cost: 1,
    preconditions: { player: { x: thing.x, y: thing.y } },
    effects: {
      toAdd: {
        things: [
          {
            id: "4",
            name: ThingType.CAMPFIRE,
            type: ThingType.CAMPFIRE,
            x: state.player.x,
            y: state.player.y,
            symbol: "🔥",
            actions: [],
          },
        ],
      },
      toRemove: {},
    },

    perform(): boolean {
      return true;
    },
  };
}

export { StartFire };
