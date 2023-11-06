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
      const wood = state.quadtree
        .queryAll()
        .find((t) => t.type === thing.type && t.x === thing.x && t.y === thing.y);
      if (player && wood && player.x === wood.x && player.y === wood.y) {
        return true;
      }
      return false;
    },

    perform(state: CombinedState) {
      state.quadtree.insert(createThing(ThingType.CAMPFIRE, { x: thing.x, y: thing.y }));
      const wood = state.quadtree
        .queryAll()
        .find((t) => t.type === thing.type && t.x === thing.x && t.y === thing.y);
      state.quadtree.remove(wood as Thing);

      return state;
    },
  };
}

export { StartFire };
