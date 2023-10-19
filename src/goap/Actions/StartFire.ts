import { CombinedState } from "../GOAPPlanner";
import { Thing } from "../../World";
import { Action } from "../Action";
import { ThingType, createThing } from "../../Thing";

function StartFire(state: CombinedState, thing: Thing): Action {
  return {
    name: "StartFire",
    target: thing,
    cost: 1,
    preconditions: { player: { x: thing.x, y: thing.y } },

    perform(state: CombinedState) {
      state.things = state.things.filter((item) => item.id !== thing.id);
      state.things.push(createThing(ThingType.CAMPFIRE, { x: state.player.x, y: state.player.y }));
      return state;
    },
  };
}

export { StartFire };
