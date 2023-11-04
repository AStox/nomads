import { Player } from "../Player";
import { Goal } from "../goap/Goals";
import logger from "../utils/Logger";
import { BehaviorNode } from "./BaseNodes";

class SetGoal extends BehaviorNode {
  player: Player;
  goal: Goal;

  constructor(player: any, goal: Goal) {
    super();
    this.player = player;
    this.goal = goal;
  }

  run(context: any): boolean {
    logger.log("Setting goal.");
    this.player.currentGoal = this.goal;
    return true;
  }
}

export { SetGoal };
