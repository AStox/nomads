import { Item, ItemType } from "../Items";
import { Player, playerState } from "../Player";
import { Thing, ThingType } from "../Things";
import { WorldState } from "../World";
import { Action } from "./Action";
import { Goal } from "./Goals";
import { omitFields } from "../utils/omitFields";
import { deepCloneWithActionReference } from "../utils/DeepClone";

interface Node {
  parent: Node | null;
  action: Action | null;
  state: CombinedState;
  cost: number;
}

export interface CombinedState extends WorldState {
  player: playerState;
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
    const combinedState: CombinedState = {
      ...worldState,
      player: omitFields(player, ["skillTree", "behaviorTree"]) as unknown as playerState,
    };

    // Initialize the starting node
    const startNode: Node = { parent: null, action: null, state: combinedState, cost: 0 };

    // Early return if goal is already met
    if (this.goalMet(goal, combinedState)) {
      console.log("Goal already met. No actions needed.");
      return plan;
    }

    let nodes: Node[] = [startNode];
    console.log("Starting plan generation...");

    let sequenceCount = 0;

    while (nodes.length > 0) {
      sequenceCount++;
      console.log(`\n--- Considered Sequence ${sequenceCount} ---`);
      const currentNode = nodes.shift()!;
      const availableActions = this.generateActions(currentNode.state, globalActions);

      // Log current state and available actions
      console.log("Current Node, Things:", this.describeThings(currentNode.state.things));

      console.log("Available Actions: ", this.describeActions(availableActions));

      for (const action of availableActions) {
        if (this.isActionExecutable(action, currentNode.state)) {
          const newState = this.executeAction(action, currentNode.state);
          const newCost = currentNode.cost + action.cost;
          const newNode: Node = {
            parent: currentNode,
            action: action,
            state: newState,
            cost: newCost,
          };

          // Log actions taken and the resulting state
          console.log(
            `Action executed: ${action.name}(${
              action.target?.name
            }), New Things: ${currentNode.state.things
              .map((thing) => `${thing.name} at (${thing.x}, ${thing.y})`)
              .join(", ")}`
          );

          if (this.goalMet(goal, newNode.state)) {
            console.log("Goal met! Reconstructing plan...");

            let node = newNode;
            while (node.parent) {
              if (node.action) {
                plan.unshift(node.action);
              }
              node = node.parent;
            }

            console.log(
              `Final Plan: ${plan.map((p) => `${p.name}(${p.target.name})`).join(" -> ")}`
            );
            return plan;
          }

          nodes.push(newNode);
        } else {
          console.log(`Action not executable: ${action.name}(${action.target.name}})`);
        }
      }
    }

    console.log("No valid plan found.");
    return [];
  }

  private static describeThings(things: Thing[]): string {
    return things.map((t) => `${t.name} at (${t.x}, ${t.y})`).join(", ");
  }

  private static describeActions(actions: Action[]): string {
    return actions.map((a) => `${a.name}(${a.target.name})`).join(", ");
  }

  private static generateActions(state: CombinedState, globalActions: Function[]): Action[] {
    let actions: Action[] = [];

    for (const thing of state.things) {
      if (thing.id === state.player.id) {
      for (const createAction of thing.actions) {
        actions.push(createAction(state, thing));
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

  private static mergeObjects(target: any, source: any): any {
    for (const key in source) {
      if (typeof source[key] === "object" && source[key] !== null) {
        if (!target[key]) target[key] = {};
        this.mergeObjects(target[key], source[key]);
      } else {
        target[key] = source[key];
      }
    }
    return target;
  }

  private static executeAction(action: Action, state: CombinedState): CombinedState {
    const newState = deepCloneWithActionReference(state);
    this.mergeObjects(newState, action.effects);
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
      if (key === "inventory" && Array.isArray(sub[key])) {
        if (!this.inventoryRequirementsMet(sub[key], obj[key])) {
          return false;
        }
      } else if (key === "things" && Array.isArray(sub[key])) {
        if (!this.inventoryRequirementsMet(sub[key], obj[key])) {
          return false;
        }
      } else if (typeof sub[key] === "object" && sub[key] !== null) {
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
