import logger from "../utils/Logger";
import { BehaviorNode } from "./BaseNodes";

class CheckHunger extends BehaviorNode {
  player: any; // specify the player type if you have one

  constructor(player: any) {
    // specify the player type if you have one
    super();
    this.player = player;
  }

  run(context: any): boolean {
    // specify the context type if you have one
    if (this.player.hunger < this.player.hungerActionThreshold) {
      logger.log("Hunger below threshold.");
      return true;
    }
    logger.log("Hunger Okay.");
    return false;
  }
}

export { CheckHunger };
