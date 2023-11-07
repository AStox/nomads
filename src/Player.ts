import { Goal } from "./goap/Goals";
import { createBehaviorTree } from "./PlayerBehaviourTree";
import { Thing } from "./World";
import { CombinedState, GOAPPlanner } from "./goap/GOAPPlanner";
import { WalkTo } from "./goap/Actions/WalkTo";
import { Action } from "./goap/Action";
import { ThingType, createThing } from "./Thing";
import logger from "./utils/Logger";
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
  currentPlan: Action[] | null;
  GOAPStatus: string;
  // skillTree: SkillTree;

  constructor(id: string, name: string, x: number, y: number, symbol: string, actions: Function[]) {
    this.id = id;
    this.name = name;
    this.type = ThingType.PLAYER;
    this.x = x;
    this.y = y;
    this.symbol = "🧍";
    this.actions = actions;
    this.speed = 2;
    this.inventory = [
      createThing(ThingType.AXE),
      createThing(ThingType.SAW),
      createThing(ThingType.MUSHROOM),
    ];
    this.hunger = 20;
    this.maxHunger = 100;
    this.hungerActionThreshold = 25;
    this.HP = 40;
    this.maxHP = 100;
    this.HPActionThreshold = 50;
    this.longGoals = [
      {
        requiredSkills: [],
        requirements: (state: CombinedState) =>
          state.player.inventory.some((item) => item.type === ThingType.BERRY),
      },
    ];
    this.currentGoal = null;
    this.currentPlan = null;
    this.GOAPStatus = "idle";
    // this.skillTree = createSkillTree();
  }

  makeDecision(state: CombinedState) {
    const context = { rng: 0 };
    const behaviorTree = createBehaviorTree(this);
    behaviorTree.run(context);
    let actionFactories = [WalkTo];

    if (this.currentGoal) {
      if (
        !this.currentPlan ||
        this.currentPlan.length === 0 ||
        !this.currentPlan[0].preconditions(state)
        //   // this.hasCompletedAction(state, this.currentPlan)
      ) {
        this.currentPlan = GOAPPlanner.plan(this, state, this.currentGoal, actionFactories);
      }
      logger.log("\n~~Plan~~");
      for (let i = 0; i < this.currentPlan.length; i++) {
        logger.log(
          `${i + 1}. ${this.currentPlan[i].name}(${this.currentPlan[i].target.name})[${
            this.currentPlan[i].target.id
          }]}]`
        );
      }
    }
    logger.log("~~Execute Action~~");
    if (this.currentPlan && this.currentPlan.length > 0) {
      const action = this.currentPlan[0];
      if (action.preconditions(state)) {
        action.perform(state);
      }
      if (this.hasCompletedAction(state, this.currentPlan)) {
        this.currentPlan.shift();
      }
      logger.log(`${action.name}(${action.target.name})`);
    }
  }

  hasCompletedAction(state: CombinedState, plan: Action[]): boolean {
    // console.log("!!!!!!!!!!!!!!!!!! has completed action");
    // console.log("plan length", plan.length);
    if (plan.length > 0) {
      if (plan.length > 1) {
        // console.log("plan[1].name", plan[1].name, plan[1].target.name);
        // console.log("plan[1].preconditions(state);", plan[1].preconditions(state));
        return plan[1].preconditions(state);
      } else {
        return this.currentGoal?.requirements(state) as boolean;
      }
    }
    return true;
  }
}
