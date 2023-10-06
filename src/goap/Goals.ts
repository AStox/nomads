import { Item, ItemType } from "../Items";
import { Player } from "../Player";
import { ThingType } from "../Things";
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

  reward: string;
}

export enum GoalType {
  CHEF = "CHEF",
  FIRE_STARTER = "FIRE_STARTER",
  GO_TO = "GO_TO",
}

// export const Goals: { [GoalType]: Goal } = {
//   [GoalType.CHEF]: { requiredSkills: [Skills.COOKING_3], requirements: {}, reward: "Chef" },
// [GoalType.FIRE_STARTER]: {
//   requiredSkills: [Skills.FIRE_MAKING_3],
//   requirements: {},
//   reward: "Fire Starter",
// },
// [GoalType.GO_TO]: {
//   requiredSkills: [],
//   requirements: { x: 10, y: 10 },
//   reward: "Go To",
// },
// };
