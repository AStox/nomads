import { Goal } from "./Goals";
import { Skills } from "../configs/Skills";
import { WorldState } from "../World";

function BuildHouse(): Goal {
  return {
    requiredSkills: [Skills.BUILDING_1],
    requirements: {},
    reward: "Build House",
    // evaluate: (worldState: WorldState) => 10,
    // evaluate: (worldState: WorldState) => playerState.hasWood ? 10 : 0,
  };
  // evaluate(worldState: any): number {
  //   // Evaluate goal logic here, higher is better
  //   return worldState.hasWood ? 10 : 0;
  // }
  // reward: string = "Build House";
}

export { BuildHouse };
