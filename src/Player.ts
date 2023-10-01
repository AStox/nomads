// Player.ts

import { SkillTree } from "./SkillTree";
import { Goals, Goal, GoalTypes } from "./goap/Goals";
import { createSkillTree } from "./CreateSkillTree";
import { createBehaviorTree } from "./PlayerBehaviourTree";
import { BehaviorNode } from "./behaviorTree/BaseNodes";
import { Thing } from "./World";
import { GOAPPlanner } from "./goap/GOAPPlanner";

export interface PlayerState {
  inventory: string[];
  hunger: number;
  maxHunger: number;
  hungerActionThreshold: number;
  HP: number;
  maxHP: number;
  HPActionThreshold: number;
  speed: number;
  longGoals: Goal[];
  currentGoal: Goal[];
  skillTree: SkillTree;
}

export class Player extends Thing {
  x: number;
  y: number;
  symbol: string;
  behaviorTree: BehaviorNode;
  playerState: PlayerState;

  constructor(x: number, y: number) {
    super(x, y, "🧍");
    this.x = x;
    this.y = y;
    this.symbol = "🧍";
    this.playerState = {
      inventory: [] as string[],
      hunger: 100,
      maxHunger: 100,
      hungerActionThreshold: 25,
      HP: 100,
      maxHP: 100,
      HPActionThreshold: 50,
      speed: 5,
      longGoals: [Goals[GoalTypes.FIRE_STARTER], Goals[GoalTypes.CHEF]],
      currentGoal: [],
      skillTree: createSkillTree(),
    };

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

    this.x += Math.round(vector.dx * this.playerState.speed);
    this.y += Math.round(vector.dy * this.playerState.speed);
  }

  makeDecision(worldState: any) {
    // TODO: Specify worldState type
    const context = { rng: 0 };
    this.behaviorTree.run(context);
    const goal = this.playerState.currentGoal[0];
    // let goal = new BuildHouse();
    // let availableActions = [new GatherWood()];

    let plan = GOAPPlanner.plan(this, this.playerState, worldState, goal, availableActions);
  }
}
