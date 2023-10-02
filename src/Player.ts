// Player.ts

import { SkillTree } from "./SkillTree";
import { Goals, Goal, GoalTypes } from "./goap/Goals";
import { createSkillTree } from "./CreateSkillTree";
import { createBehaviorTree } from "./PlayerBehaviourTree";
import { BehaviorNode } from "./behaviorTree/BaseNodes";
import { Thing } from "./World";
import { CombinedState, GOAPPlanner } from "./goap/GOAPPlanner";
import { WalkTo } from "./goap/Actions/WalkTo";
import { Action } from "./goap/Action";

export interface PlayerState {
  player: Player;
  x: number;
  y: number;
  inventory: string[];
  hunger: number;
  maxHunger: number;
  hungerActionThreshold: number;
  HP: number;
  maxHP: number;
  HPActionThreshold: number;
  speed: number;
  longGoals: Goal[];
  currentGoal: Goal | null;
  skillTree: SkillTree;
}

export class Player extends Thing {
  symbol: string;
  behaviorTree: BehaviorNode;
  playerState: PlayerState;

  constructor(x: number, y: number) {
    super(x, y, "🧍");
    this.symbol = "🧍";
    this.playerState = {
      player: this,
      x: x,
      y: y,
      inventory: [] as string[],
      hunger: 100,
      maxHunger: 100,
      hungerActionThreshold: 25,
      HP: 100,
      maxHP: 100,
      HPActionThreshold: 50,
      speed: 5,
      longGoals: [Goals[GoalTypes.GO_TO]],
      currentGoal: null,
      skillTree: createSkillTree(),
    };

    this.behaviorTree = createBehaviorTree(this);
  }

  moveTo(x: number, y: number) {
    this.playerState.x = x;
    this.playerState.y = y;
    return true;
  }

  makeDecision(state: CombinedState) {
    const context = { rng: 0 };
    this.behaviorTree.run(context);
    const goal = this.playerState.currentGoal;
    // let goal = new BuildHouse();
    let availableActions: Action[] = [];
    let actionFactories = [WalkTo];

    let plan: Action[] = [];
    if (goal) {
      plan = GOAPPlanner.plan(
        this,
        this.playerState,
        state,
        goal,
        availableActions,
        actionFactories
      );
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
      const success = firstAction.perform(this);
    }
  }
}
