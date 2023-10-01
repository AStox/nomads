import { Skills } from "./Skills";

export interface Goal {
  requirements: Skills[];
  reward: string;
}

export enum GoalTypes {
  CHEF = "CHEF",
  FIRE_STARTER = "FIRE_STARTER",
}

export const Goals: { [key in GoalTypes]: Goal } = {
  [GoalTypes.CHEF]: { requirements: [Skills.COOKING_3], reward: "Chef" },
  [GoalTypes.FIRE_STARTER]: { requirements: [Skills.FIRE_MAKING_3], reward: "Fire Starter" },
};
