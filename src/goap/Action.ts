import { Thing } from "../Thing";
import { CombinedState } from "./GOAPPlanner";
import { DeepPartial } from "../utils/DeepPartial";
import { Ingredient } from "../Recipe";

interface Action {
  name: string;
  cost: number;
  preconditions: any;
  effects: {
    toAdd?: DeepPartial<CombinedState>;
    toRemove?: DeepPartial<Omit<CombinedState, "player">> & {
      player?: { inventory?: Ingredient[] };
    };
  };

  target: Thing;

  perform(state: CombinedState): CombinedState;
}

export type { Action };
