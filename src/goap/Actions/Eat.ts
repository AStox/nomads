import { CombinedState } from "../GOAPPlanner";
import { Thing, World } from "../../World";
import { Action } from "../Action";
import { Food, ThingType, createThing } from "../../Thing";

function Eat(state: CombinedState, thing: Thing): Action {
  return {
    name: "Eat",
    target: thing,
    cost: 1,
    preconditions: { player: { inventory: [thing] } },
    effects: {
      toAdd: { player: { hunger: (thing as Food).satiation } },
      toRemove: { things: [thing] },
    },

    perform(state: CombinedState) {
      state.player.hunger += (thing as Food).satiation;
      state.player.inventory = state.player.inventory.filter((item) => item.id !== thing.id);
      return state;
    },
  };
}

export { Eat };
