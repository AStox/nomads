import { Skills } from "../configs/Skills";

export interface Goal {
  requiredSkills: Skills[];
  // requiredItems?: Items[];
  // requiredThings?: Things[];

  reward: string;
}

export enum GoalTypes {
  CHEF = "CHEF",
  FIRE_STARTER = "FIRE_STARTER",
}

export const Goals: { [key in GoalTypes]: Goal } = {
  [GoalTypes.CHEF]: { requiredSkills: [Skills.COOKING_3], reward: "Chef" },
  [GoalTypes.FIRE_STARTER]: {
    requiredSkills: [Skills.FIRE_MAKING_3],
    reward: "Fire Starter",
  },
};
