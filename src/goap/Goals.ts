import { Player } from "../Player";
import { Thing, ThingType } from "../Thing";
import { WorldState } from "../World";
import { Skills } from "../configs/Skills";
import { CombinedState } from "./GOAPPlanner";

interface GoalWorldState extends Partial<Omit<WorldState, "player" | "things">> {
  player?: Partial<Omit<Player, "inventory">> & { inventory?: ThingType[] };
  things?: ThingType[];
}

export interface Goal {
  requirements: GoalWorldState;
  requiredSkills: Skills[];
  // requiredItems?: ItemType[];
  // requiredThings?: Things[];

  // reward: string;
}

export enum GoalType {
  CHEF = "CHEF",
  FIRE_STARTER = "FIRE_STARTER",
  GO_TO = "GO_TO",
}
