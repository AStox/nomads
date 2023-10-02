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
    if (this.player.playerState.longGoals.length > 0) {
      const index = Math.floor(context.rng * this.player.playerState.longGoals.length);
      this.player.playerState.currentGoal = this.player.playerState.longGoals[index];
      console.log("Player has longterm goals. Goal: " + this.player.playerState.currentGoal.reward);
      return true;
    }
    console.log("Player has no longterm goals.");
    return false;
  }
}

export { CheckLongGoals };
