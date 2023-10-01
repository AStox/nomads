// Player.ts

import { SkillTree } from "./SkillTree";
import { Goals } from "./configs/Goals";
import { createSkillTree } from "./CreateSkillTree";
import { createBehaviorTree } from "./PlayerBehaviourTree";
import { BehaviorNode } from "./behaviorTree/BaseNodes";

export class Player {
  x: number;
  y: number;
  symbol: string;
  skillTree: SkillTree;
  hunger: number;
  maxHunger: number;
  hungerActionThreshold: number;
  HP: number;
  maxHP: number;
  HPActionThreshold: number;
  speed: number;
  longGoals: Goals[];
  currentGoal: Goals[];
  behaviorTree: BehaviorNode;

  constructor(x: number, y: number) {
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

  normalizeVector(dx: number, dy: number): { dx: number; dy: number } {
    const length = Math.sqrt(dx * dx + dy * dy);
    return {
      dx: dx / length,
      dy: dy / length,
    };
  }

  moveTowards(targetX: number, targetY: number): void {
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
    console.log("Making decision.");
    this.behaviorTree.run(context);
  }
}
