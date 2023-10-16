// Player.ts

import { SkillTree } from "./SkillTree";
import { Goal, GoalType } from "./goap/Goals";
import { createSkillTree } from "./CreateSkillTree";
import { createBehaviorTree } from "./PlayerBehaviourTree";
import { BehaviorNode } from "./behaviorTree/BaseNodes";
import { Thing, World } from "./World";
import { CombinedState, GOAPPlanner } from "./goap/GOAPPlanner";
import { WalkTo } from "./goap/Actions/WalkTo";
import { Action } from "./goap/Action";
import { ThingType } from "./Thing";
import { PickUp } from "./goap/Actions/PickUp";
interface PartialWithMoveToPlayer extends Partial<Player> {
  moveTo: (x: number, y: number) => boolean;
}

export type playerState = Omit<Player, "skillTree" | "behaviorTree">;

export class Player implements Thing {
  id: string;
  name: string;
  type: ThingType;
  x: number;
  y: number;
  symbol: string;
  actions: Function[];
  speed: number;
  inventory: Thing[];
  hunger: number;
  maxHunger: number;
  hungerActionThreshold: number;
  HP: number;
  maxHP: number;
  HPActionThreshold: number;
  longGoals: Goal[];
  currentGoal: Goal | null;
  // skillTree: SkillTree;

  constructor(id: string, name: string, x: number, y: number, symbol: string, actions: Function[]) {
    this.id = id;
    this.name = name;
    this.type = ThingType.PLAYER;
    this.x = x;
    this.y = y;
    this.symbol = "🧍";
    this.actions = actions;
    this.speed = 5;
    this.inventory = [];
    this.hunger = 100;
    this.maxHunger = 100;
    this.hungerActionThreshold = 25;
    this.HP = 100;
    this.maxHP = 100;
    this.HPActionThreshold = 50;
    this.longGoals = [
      {
        requiredSkills: [],
        requirements: {
          player: {
            inventory: [ThingType.AXE, ThingType.WOOD],
          },
        },
      },
    ];
    this.currentGoal = null;
    // this.skillTree = createSkillTree();
  }

  moveTo(x: number, y: number) {
    this.x = x;
    this.y = y;
    return true;
  }

  pickUp(thing: Thing) {
    this.inventory.push(thing);
    // remove thing from world.things
    const world = World.getInstance();
    world.removeThing(thing);
    return true;
  }

  drop(thing: Thing) {
    this.inventory = this.inventory.filter((item) => item.id !== thing.id);
    const world = World.getInstance();
    world.addThing(thing);
    return true;
  }

  makeDecision(state: CombinedState) {
    const context = { rng: 0 };
    const behaviorTree = createBehaviorTree(this);
    behaviorTree.run(context);
    const goal = this.currentGoal;
    let actionFactories = [WalkTo];

    let plan: Action[] = [];
    if (goal) {
      plan = GOAPPlanner.plan(this, state, goal, actionFactories);
      console.log(" ");
      console.log("~~Plan~~");
      for (let i = 0; i < plan.length; i++) {
        console.log(`${i + 1}. ${plan[i].name}(${plan[i].target.name})`);
      }
    }

    // console.log(" ");
    // console.log("~Performing plan~");

    // if (plan.length > 0) {
    //   const firstAction = plan[0];
    //   const success = firstAction.perform();
    // }
  }
}
