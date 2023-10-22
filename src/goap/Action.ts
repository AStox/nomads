import { Thing } from "../Thing";
import { CombinedState } from "./GOAPPlanner";

interface Action {
  name: string;
  cost: number;
  target: Thing;
  preconditions: (state: CombinedState) => boolean;

  perform(state: CombinedState): CombinedState;
}

export type { Action };
