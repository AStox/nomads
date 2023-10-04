import { Item, ItemType } from "../Items";
import { Player } from "../Player";
import { WorldState } from "../World";
import { Action } from "./Action";
import { Goal } from "./Goals";

interface Node {
  parent: Node | null;
  action: Action | null;
  state: CombinedState;
  cost: number;
}

export interface CombinedState extends WorldState {
  player: Player;
}

class GOAPPlanner {
  static plan(
    player: Player,
    worldState: WorldState,
    goal: Goal,
    actions: Action[],
    globalActions: Function[]
  ): Action[] {
    let plan: Action[] = [];

    // Combine world and player states for comprehensive planning
    const combinedState: CombinedState = { ...worldState, player: player };

    // add the global actions to the list of possible actions
    for (const factory of globalActions) {
      actions.push(factory(combinedState));
    }

    // for each thing, add its actions to the list of possible actions
    for (const thing of worldState.things) {
      for (const createAction of thing.actions) {
        actions.push(createAction(thing));
      }
    }

    // if (goal.requiredLocation) {
    //   for (const factory of LocationActionFactories) {
    //     const dynamicAction = factory(combinedState, goal);
    //     if (dynamicAction) {
    //       actions.push(dynamicAction);
    //     }
    //   }
    // }

    // Initialize end goal node
    const startNode: Node = { parent: null, action: null, state: combinedState, cost: 0 };

    // Check if goal is already satisfied
    if (this.goalMet(goal, combinedState)) {
      console.log("Goal met: ", this.goalMet(goal, combinedState));
      return plan;
    }

    // Perform planning using backtracking search
    let nodes: Node[] = [startNode];
    while (nodes.length > 0) {
      const currentNode = nodes.shift()!;

      // Generate child nodes
      for (const action of actions) {
        if (this.isActionExecutable(action, currentNode.state)) {
          const newState = this.executeAction(action, currentNode.state);
          const newCost = currentNode.cost + action.cost;
          const newNode: Node = {
            parent: currentNode,
            action: action,
            state: newState,
            cost: newCost,
          };

          // Check if this node satisfies the goal
          if (this.goalMet(goal, newNode.state)) {
            // Reconstruct the plan from this node
            let node = newNode;
            while (node.parent) {
              if (node.action) plan.unshift(node.action);
              node = node.parent;
            }
            return plan;
          }
          nodes.push(newNode);
        }
      }
    }

    // No valid plan found
    return [];
  }

  private static isActionExecutable(action: Action, state: CombinedState): boolean {
    for (const key in action.preconditions) {
      if (state[key as keyof typeof state] !== action.preconditions[key as keyof typeof state]) {
        return false;
      }
    }
    return true;
  }

  private static executeAction(action: Action, state: CombinedState): CombinedState {
    const newState = { ...state } as any;
    for (const key in action.effects) {
      if (key in newState) {
        newState[key as keyof CombinedState] = action.effects[key as keyof CombinedState];
      }
    }
    return newState;
  }

  private static goalMet(goal: Goal, state: CombinedState): boolean {
    return this.matchesNestedKeys(goal.requirements, state);
  }

  private static matchesNestedKeys(sub: any, obj: any): boolean {
    for (const key in sub) {
      if (typeof sub[key] === "object" && sub[key] !== null) {
        if (!this.matchesNestedKeys(sub[key], obj[key])) {
          return false;
        }
      } else {
        if (sub[key] !== obj[key]) {
          return false;
        }
      }
    }
    return true;
  }
}

export { GOAPPlanner };
