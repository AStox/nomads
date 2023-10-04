// Player.ts

import { SkillTree } from "./SkillTree";
import { Goal, GoalType } from "./goap/Goals";
import { createSkillTree } from "./CreateSkillTree";
import { createBehaviorTree } from "./PlayerBehaviourTree";
import { BehaviorNode } from "./behaviorTree/BaseNodes";
import { Thing } from "./World";
import { CombinedState, GOAPPlanner } from "./goap/GOAPPlanner";
import { WalkTo } from "./goap/Actions/WalkTo";
import { Action } from "./goap/Action";
import { ItemType } from "./Items";
import { ThingType } from "./Things";
interface PartialWithMoveToPlayer extends Partial<Player> {
  moveTo: (x: number, y: number) => boolean;
}

export class Player implements Thing {
  behaviorTree: BehaviorNode;
  name: ThingType;
  x: number;
  y: number;
  symbol: string;
  actions: Function[];
  speed: number;
  inventory: ItemType[];
  hunger: number;
  maxHunger: number;
  hungerActionThreshold: number;
  HP: number;
  maxHP: number;
  HPActionThreshold: number;
  longGoals: Goal[];
  currentGoal: Goal | null;
  skillTree: SkillTree;

  constructor(name: ThingType, x: number, y: number, symbol: string, actions: Function[]) {
    this.name = name;
    this.x = x;
    this.y = y;
    this.symbol = "🧍";
    this.actions = actions;
    this.speed = 5;
    this.inventory = [] as ItemType[];
    this.hunger = 100;
    this.maxHunger = 100;
    this.hungerActionThreshold = 25;
    this.HP = 100;
    this.maxHP = 100;
    this.HPActionThreshold = 50;
    this.longGoals = [
      {
        requiredSkills: [],
        requirements: { player: { inventory: [] as ItemType[] } },
        requiredItems: [ItemType.AXE],
        reward: "Axe",
      },
    ];
    this.currentGoal = null;
    this.skillTree = createSkillTree();
    this.behaviorTree = createBehaviorTree(this);
  }

  moveTo(x: number, y: number) {
    this.x = x;
    this.y = y;
    return true;
  }

  pickUp(item: ItemType) {
    this.inventory.push(item);
    return true;
  }

  putDown(item: ItemType) {
    const index = this.inventory.indexOf(item);
    if (index > -1) {
      this.inventory.splice(index, 1);
      return true;
    }
    return false;
  }

  makeDecision(state: CombinedState) {
    const context = { rng: 0 };
    this.behaviorTree.run(context);
    const goal = this.currentGoal;
    // let goal = new BuildHouse();
    let availableActions: Action[] = [];
    let actionFactories = [WalkTo];

    let plan: Action[] = [];
    if (goal) {
      plan = GOAPPlanner.plan(this, state, goal, availableActions, actionFactories);
      console.log(" ");
      console.log("~~Plan~~");
      for (const action of plan) {
        console.log(action.name);
      }
    }

    console.log(" ");
    console.log("~Performing plan~");

    if (plan.length > 0) {
      const firstAction = plan[0];
      const success = firstAction.perform();
    }
  }
}
