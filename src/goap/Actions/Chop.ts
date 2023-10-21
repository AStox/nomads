import { CombinedState } from "../GOAPPlanner";
import { Thing } from "../../World";
import { Action } from "../Action";
import { ThingType, createThing } from "../../Thing";

function Chop(state: CombinedState, thing: Thing): Action {
  return {
    name: "Chop",
    target: thing,
    cost: 1,
    preconditions: { player: { x: thing.x, y: thing.y, inventory: [ThingType.AXE] } },

    perform(state: CombinedState) {
      state.quadtree.remove(thing);
      state.quadtree.insert(createThing(ThingType.WOOD, { x: thing.x, y: thing.y }));
      return state;
    },
  };
}

export { Chop };
