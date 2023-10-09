import { Thing } from "../Things";
import { CombinedState } from "./GOAPPlanner";
import { DeepPartial } from "../utils/DeepPartial";

interface Action {
  name: string;
  cost: number;
  preconditions: any;
  effects: {
    toAdd?: DeepPartial<CombinedState>;
    toRemove?: DeepPartial<CombinedState>;
  };
  target: Thing;

  perform(): boolean;
}

export type { Action };
