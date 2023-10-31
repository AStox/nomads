import { CombinedState, GOAPPlanner } from "../GOAPPlanner";
import { Thing } from "../../World";
import { Action } from "../Action";
import { ThingType, createThing } from "../../Thing";

function Chop(state: CombinedState, thing: Thing): Action {
  return {
    name: "Chop",
    target: thing,
    cost: 1,
    actionFilter: (state: CombinedState) => {
      return GOAPPlanner.generateActions(state, []);
    },
    preconditions: (state: CombinedState) => {
      const player = state.quadtree.queryAll().find((t) => t.id === state.player.id);
      if (
        player &&
        player.x === thing.x &&
        player.y === thing.y &&
        state.player.inventory.find((item) => item.type === ThingType.AXE)
      ) {
        return true;
      }

      return false;
    },
    perform(state: CombinedState) {
      state.quadtree.remove(thing);
      state.quadtree.insert(createThing(ThingType.WOOD, { x: thing.x, y: thing.y }));
      return state;
    },
  };
}

export { Chop };
