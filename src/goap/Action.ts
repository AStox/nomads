import { PlayerState } from "../Player";
import { WorldState } from "../World";
import { CombinedState } from "./GOAPPlanner";

interface Action {
  cost: number;
  preconditions: any;
  effects: any;

  perform(agent: any): boolean;
}

export type { Action };
