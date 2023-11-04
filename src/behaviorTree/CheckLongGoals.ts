import logger from "../utils/Logger";
import { BehaviorNode } from "./BaseNodes";

class CheckLongGoals extends BehaviorNode {
  player: any; // specify the player type if you have one

  constructor(player: any) {
    // specify the player type if you have one
    super();
    this.player = player;
  }

  run(context: any): boolean {
    // specify the context type if you have one
    if (this.player.longGoals.length > 0) {
      const index = Math.floor(context.rng * this.player.longGoals.length);
      this.player.currentGoal = this.player.longGoals[index];
      logger.log("Player has longterm goals. Goal: " + this.player.currentGoal.reward);
      return true;
    }
    logger.log("Player has no longterm goals.");
    return false;
  }
}

export { CheckLongGoals };
