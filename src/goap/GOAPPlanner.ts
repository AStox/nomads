import { Item, ItemType } from "../Items";
import { Player } from "../Player";
import { Thing, ThingType } from "../Things";
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
  static DEBUG = false;

  static plan(
    player: Player,
    worldState: WorldState,
    goal: Goal,
    globalActions: Function[]
  ): Action[] {
    let plan: Action[] = [];
    // Combine world and player states for comprehensive planning
    const combinedState: CombinedState = { ...worldState, player: player };

    // add the global actions to the list of possible actions
    // for (const factory of globalActions) {
    //   actions.push(factory(combinedState));
    // }

    // for each thing, add its actions to the list of possible actions
    let actions = this.generateActions(combinedState, globalActions);

    console.log("Actions: ", actions);

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
      console.log("actions: ", actions);
      const newActions: Action[] = [];
      const currentNode = nodes.shift()!;

      // Generate child nodes
      for (const action of actions) {
        if (this.DEBUG) {
          console.log(" ");
          console.log("-------------------------------------------");
          console.log("Action: ", action.name);
          console.log("effects: ", action.effects);
          console.log("preconditions: ", action.preconditions);
          console.log("Action is executable: ", this.isActionExecutable(action, currentNode.state));
        }
        if (this.isActionExecutable(action, currentNode.state)) {
          const newState = this.executeAction(action, currentNode.state);
          newActions.push(...this.generateActions(newState, globalActions));
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
      actions = newActions.length > 0 ? newActions : actions;
    }

    // No valid plan found
    return [];
  }

  private static generateActions(state: CombinedState, globalActions: Function[]): Action[] {
    let actions: Action[] = [];

    for (const thing of state.things) {
      for (const createAction of thing.actions) {
        actions.push(createAction(state, thing));
        console.log(actions);
      }
    }
    return actions;
  }

  private static isActionExecutable(action: Action, state: CombinedState): boolean {
    return this.matchesNestedKeys(action.preconditions, state);
  }

  private static deepClone(obj: any, hash = new WeakMap()): any {
    if (Object(obj) !== obj) return obj;
    if (hash.has(obj)) return hash.get(obj);
    const result = Array.isArray(obj)
      ? []
      : obj.constructor
      ? new obj.constructor()
      : Object.create(null);
    hash.set(obj, result);
    return Object.assign(
      result,
      ...Object.keys(obj).map((key) => ({ [key]: this.deepClone(obj[key], hash) }))
    );
  }

  // Then use deepClone in your executeAction function
  private static executeAction(action: Action, state: CombinedState): CombinedState {
    const newState = this.deepClone(state) as CombinedState;
    this.updateNestedFields(newState, action.effects);
    return newState;
  }

  private static updateNestedFields(obj: any, effects: any) {
    for (const key in effects) {
      if (obj[key] === undefined) {
        obj[key] = effects[key];
      } else if (typeof effects[key] === "object" && effects[key] !== null) {
        this.updateNestedFields(obj[key], effects[key]);
      } else {
        obj[key] = effects[key];
      }
    }
  }

  private static goalMet(goal: Goal, state: CombinedState): boolean {
    return this.matchesNestedKeys(goal.requirements, state);
  }

  private static matchesNestedKeys(sub: any, obj: any): boolean {
    for (const key in sub) {
      if (this.DEBUG) console.log("Key: ", key);
      if (key === "inventory" && Array.isArray(sub[key])) {
        if (!this.inventoryRequirementsMet(sub[key], obj[key])) {
          if (this.DEBUG) console.log("Inventory requirements not met");
          return false;
        }
      } else if (key === "things" && Array.isArray(sub[key])) {
        if (!this.inventoryRequirementsMet(sub[key], obj[key])) {
          if (this.DEBUG) console.log("Inventory requirements not met");
          return false;
        }
      } else if (typeof sub[key] === "object" && sub[key] !== null) {
        if (!this.matchesNestedKeys(sub[key], obj[key])) {
          if (this.DEBUG) console.log("Nested keys don't match");
          return false;
        }
      } else {
        if (sub[key] !== obj[key]) {
          if (this.DEBUG) console.log("Keys don't match");
          return false;
        }
      }
    }
    return true;
  }

  private static inventoryRequirementsMet(
    requiredThings: ThingType[],
    playerInventory: Thing[]
  ): boolean {
    const thingCounts = new Map<ThingType, number>();

    // Count how many things of each type the player has
    Object.values(playerInventory).forEach((thing) => {
      thingCounts.set(thing.type, (thingCounts.get(thing.type) || 0) + 1);
    });

    // Check if each required item type is met
    for (const requiredThing of requiredThings) {
      const count = thingCounts.get(requiredThing) || 0;
      if (count <= 0) {
        return false;
      }
      thingCounts.set(requiredThing, count - 1);
    }

    return true;
  }
}

export { GOAPPlanner };
