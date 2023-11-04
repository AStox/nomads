import logger from "../utils/Logger";
import { BehaviorNode } from "./BaseNodes";

class CheckHP extends BehaviorNode {
  player: any; // specify the player type if you have one

  constructor(player: any) {
    // specify the player type if you have one
    super();
    this.player = player;
  }

  run(context: any): boolean {
    // specify the context type if you have one
    if (this.player.HP < this.player.HPActionThreshold) {
      logger.log("HP below threshold.");
      return true;
    }
    logger.log("HP Okay.");
    return false;
  }
}

export { CheckHP };
