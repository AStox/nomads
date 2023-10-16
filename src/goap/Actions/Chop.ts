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
    effects: {
      toAdd: {
        things: [createThing(ThingType.WOOD, { x: thing.x, y: thing.y })],
      },
      toRemove: { things: [thing] },
    },

    perform(state: CombinedState) {
      state.things = state.things.filter((item) => item.id !== thing.id);
      state.things.push(createThing(ThingType.WOOD, { x: thing.x, y: thing.y }));
      return state;
    },
  };
}

export { Chop };
