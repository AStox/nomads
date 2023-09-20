const { SkillTree } = require("./SkillTree");
const { createBehaviorTree } = require("./PlayerBehaviourTree");
const { Goals } = require("./configs/Goals");
const { createSkillTree } = require("./CreateSkillTree");

class Player {
  constructor(x, y) {
    this.x = x;
    this.y = y;
    this.symbol = "🧍";
    this.skillTree = createSkillTree();
    this.hunger = 100;
    this.maxHunger = 100;
    this.hungerActionThreshold = 25;
    this.HP = 100;
    this.maxHP = 100;
    this.HPActionThreshold = 50;
    this.speed = 5;
    this.longGoals = [Goals.FIRE_STARTER];
    this.currentGoal = [];

    this.behaviorTree = createBehaviorTree(this);
  }

  normalizeVector(dx, dy) {
    const length = Math.sqrt(dx * dx + dy * dy);
    return {
      dx: dx / length,
      dy: dy / length,
    };
  }

  moveTowards(targetX, targetY) {
    let vector = {
      dx: targetX - this.x,
      dy: targetY - this.y,
    };

    vector = this.normalizeVector(vector.dx, vector.dy);

    this.x += Math.round(vector.dx * this.speed);
    this.y += Math.round(vector.dy * this.speed);
  }

  makeDecision() {
    const context = { rng: 0 };
    this.behaviorTree.run(context);
  }
}

module.exports = { Player };
