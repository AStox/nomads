import { PlayerState } from "../Player";
import { WorldState } from "../World";
import { Action } from "./Action";
import { Goal } from "./Goals";

interface Node {
  parent: Node | null;
  action: Action | null;
  state: CombinedState;
  cost: number;
}

export type CombinedState = WorldState & PlayerState;

class GOAPPlanner {
  static plan(
    agent: any,
    playerState: PlayerState,
    worldState: WorldState,
    goal: Goal,
    actions: Action[]
  ): Action[] {
    let plan: Action[] = [];

    // Combine world and player states for comprehensive planning
    const combinedState: CombinedState = { ...worldState, ...playerState };

    // Initialize end goal node
    const startNode: Node = { parent: null, action: null, state: combinedState, cost: 0 };

    // Check if goal is already satisfied
    if (this.goalMet(goal, combinedState)) {
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

  private static goalMet(goal: Goal, state: PlayerState): boolean {
    for (const key in goal.requiredSkills) {
      // TODO: And check required items and requiredthings
      const skill = state.skillTree.findNode(key);
      if (!skill?.achieved) {
        return false;
      }
    }
    return true;
  }
}

export { GOAPPlanner };
