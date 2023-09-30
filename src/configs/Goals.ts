import { Skills } from "./Skills";

export enum Goals {
  CHEF = "CHEF",
  FIRE_STARTER = "FIRE_STARTER",
}

export const GoalDetails: { [key in Goals]: { requirements: Skills[]; reward: string } } = {
  [Goals.CHEF]: { requirements: [Skills.COOKING_3], reward: "Chef" },
  [Goals.FIRE_STARTER]: { requirements: [Skills.FIRE_MAKING_3], reward: "Fire Starter" },
};
