// File: Player.js
const { SkillTree } = require("./SkillTree");

class Player {
  constructor(x, y) {
    this.x = x;
    this.y = y;
    this.symbol = "😀";
    this.skillTree = new SkillTree("src/configs/SkillTreeConfig.json");
    this.hunger = 100;
    this.maxHunger = 100;
    this.HP = 100;
    this.maxHP = 100;
    this.speed = 5;
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
}

module.exports = { Player };
