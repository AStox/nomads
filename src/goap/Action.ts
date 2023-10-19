import { Thing } from "../Thing";
import { CombinedState } from "./GOAPPlanner";

interface Action {
  name: string;
  cost: number;
  target: Thing;
  preconditions: any;

  perform(state: CombinedState): CombinedState;
}

export type { Action };
