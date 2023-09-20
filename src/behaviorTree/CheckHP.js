const { BehaviorNode } = require("./BaseNodes");

class CheckHP extends BehaviorNode {
  constructor(player) {
    super();
    this.player = player;
  }

  run(context) {
    if (this.player.HP < this.player.HPActionThreshold) {
      console.log("HP below threshold.");
      return true;
    }
    console.log("HP Okay.");
    return false;
  }
}
module.exports = { CheckHP };
