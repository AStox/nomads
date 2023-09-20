const { BehaviorNode } = require("./BaseNodes");

class CheckLongGoals extends BehaviorNode {
  constructor(player) {
    super();
    this.player = player;
  }

  run(context) {
    if (this.player.longGoals.length > 0) {
      const index = Math.floor(context.rng * this.player.longGoals.length);
      context.currentGoal = this.player.longGoals[index];
      console.log("Player has longterm goals. Goal: " + context.currentGoal.reward);
      return true;
    }
    console.log("Player has no longterm goals.");
    return false;
  }
}
module.exports = { CheckLongGoals };
