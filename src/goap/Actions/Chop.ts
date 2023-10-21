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
      state.things = state.things.filter((t) => t.id === thing.id);
      state.quadtree.remove(thing);
      const wood = createThing(ThingType.WOOD, { x: thing.x, y: thing.y });
      state.things.push(wood);
      state.quadtree.insert(wood);
      return state;
    },
  };
}

export { Chop };
