import { Action } from "./Action";
import { WorldState } from "../World";

class GatherWood implements Action {
  name: string = "GatherWood";
  cost = 1;
  preconditions: WorldState = { hasAxe: true };
  effects: WorldState = { hasWood: true };

  perform(agent: any): boolean {
    // Perform action logic here
    return true;
  }
}

export { GatherWood };
