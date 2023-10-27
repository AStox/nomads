import { CombinedState, GOAPPlanner } from "../GOAPPlanner";
import { Thing, World } from "../../World";
import { Action } from "../Action";
import { ThingType, createThing } from "../../Thing";

function StartFire(state: CombinedState, thing: Thing): Action {
  return {
    name: "StartFire",
    target: thing,
    cost: 1,
    actionFilter: (state: CombinedState) => {
      return GOAPPlanner.generateActions(state, []);
    },
    preconditions: (state: CombinedState) => {
      const player = state.quadtree.queryAll().find((t) => t.id === state.player.id);
      if (player && player.x === thing.x && player.y === thing.y) {
        return true;
      }
      return false;
    },

    perform(state: CombinedState) {
      state.quadtree.remove(thing);
      const player = state.quadtree.queryAll().find((t) => t.id === state.player.id);
      state.quadtree.insert(createThing(ThingType.CAMPFIRE, { x: player?.x, y: player?.y }));
      return state;
    },
  };
}

export { StartFire };
