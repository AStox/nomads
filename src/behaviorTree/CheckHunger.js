const { BehaviorNode } = require("./BaseNodes");

class CheckHunger extends BehaviorNode {
  constructor(player) {
    super();
    this.player = player;
  }

  run(context) {
    if (this.player.hunger < this.player.hungerActionThreshold) {
      console.log("Hunger below threshold.");
      return true;
    }
    console.log("Hunger Okay.");
    return false;
  }
}
module.exports = { CheckHunger };
