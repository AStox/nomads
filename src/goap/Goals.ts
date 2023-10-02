import { Skills } from "../configs/Skills";
import { CombinedState } from "./GOAPPlanner";

export interface Goal {
  requirements: Partial<CombinedState>;
  requiredSkills: Skills[];
  // requiredItems?: Items[];
  // requiredThings?: Things[];

  reward: string;
}

export enum GoalTypes {
  CHEF = "CHEF",
  FIRE_STARTER = "FIRE_STARTER",
  GO_TO = "GO_TO",
}

export const Goals: { [key in GoalTypes]: Goal } = {
  [GoalTypes.CHEF]: { requiredSkills: [Skills.COOKING_3], requirements: {}, reward: "Chef" },
  [GoalTypes.FIRE_STARTER]: {
    requiredSkills: [Skills.FIRE_MAKING_3],
    requirements: {},
    reward: "Fire Starter",
  },
  [GoalTypes.GO_TO]: {
    requiredSkills: [],
    requirements: { x: 10, y: 10 },
    reward: "Go To",
  },
};
