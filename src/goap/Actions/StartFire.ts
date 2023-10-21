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
      // TODO: make adding/removing to state and quadtree one call.
      state.things = state.things.filter((t) => t.id != thing.id);
      const result = state.quadtree.remove(thing);
      const campfire = createThing(ThingType.CAMPFIRE, { x: state.player.x, y: state.player.y });
      state.things.push(campfire);
      state.quadtree.insert(campfire);
      return state;
    },
  };
}

export { StartFire };
