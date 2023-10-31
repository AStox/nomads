import { Thing } from "../Thing";
import { CombinedState } from "./GOAPPlanner";

/// @param preconditions - A function that returns true if the action can be performed
/// @param actionFilter - A function that returns a filtered array of actions that can be performed following this action
/// @param perform - A function that simulates performing the action and returns the new state
interface Action {
  name: string;
  cost: number;
  target: Thing;
  preconditions: (state: CombinedState) => boolean;
  actionFilter: (state: CombinedState) => Action[];
  simulate?: (state: CombinedState) => CombinedState;
  perform(state: CombinedState): CombinedState;
}

export type { Action };
