import { CombinedState } from "../GOAPPlanner";
import { Thing, World } from "../../World";
import { Action } from "../Action";
import { ThingType, createThing } from "../../Thing";

function StartFire(state: CombinedState, thing: Thing): Action {
  return {
    name: "StartFire",
    target: thing,
    cost: 1,
    preconditions: { player: { x: thing.x, y: thing.y } },

    perform(state: CombinedState) {
      state.quadtree.remove(thing);
      state.quadtree.insert(
        createThing(ThingType.CAMPFIRE, { x: state.player.x, y: state.player.y })
      );
      return state;
    },
  };
}

export { StartFire };
