import { Item, ItemType } from "../Items";
import { Player, playerState } from "../Player";
import { Thing, ThingType } from "../Thing";
import { WorldState } from "../World";
import { Action } from "./Action";
import { Goal } from "./Goals";
import { omitFields } from "../utils/omitFields";
import { deepCloneWithActionReference } from "../utils/DeepClone";
import { getCraftableRecipes } from "../Recipe";
import { Craft } from "./Actions/Craft";

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
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);

      sequenceCount++;
      const currentNode = nodes.shift()!;
      // ----------------- DEBUG -----------------
      console.log(
        `\n\\n=================== Considered Sequence ${sequenceCount} ======================\n`
      );

      console.log("Current Node (", this.printActionSequence(currentNode), "). ");
      console.log(
        `Player's Inventory: ${JSON.stringify(
          currentNode.state.player.inventory.map((thing) => thing.name)
        )}`
      );
      // ----------------- DEBUG -----------------

      const availableActions = this.generateActions(currentNode.state, globalActions);

      for (const action of availableActions) {
        if (this.isActionExecutable(action, currentNode.state)) {
          if (action.name === "WalkTo" && this.isBackAndForthWalk(currentNode, action.target.id)) {
            console.log(`Skipping back-and-forth walk to ${action.target.name}`);
            continue;
          }
          const newState = this.executeAction(action, currentNode.state);
          const newCost = currentNode.cost + action.cost;
          const newNode: Node = {
            parent: currentNode,
            action: action,
            state: newState,
            cost: newCost,
          };
          // Log actions taken and the resulting state
          console.log(`Action executed: ${action.name}(${action.target?.name})`);

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

  private static generateActions(state: CombinedState, globalActions: Function[]): Action[] {
    let actions: Action[] = [];

    // Add crafting actions
    const craftableRecipes = getCraftableRecipes(state.player.inventory);
    console.log("Craftable Recipes: ", craftableRecipes);
    const craftActions: Action[] = craftableRecipes.map((recipe) => {
      // Return a new Craft action initialized with the recipe.
      // Replace `Craft` with the actual Craft action class you have.
      return Craft(state, recipe);
    });

    actions = [...actions, ...craftActions];

    for (const thing of state.things) {
      if (thing.id !== state.player.id) {
        // Skip player
        for (const createAction of thing.actions) {
          // exclude walkto action if player is already at the thing
          if (
            createAction.name === "WalkTo" &&
            state.player.x === thing.x &&
            state.player.y === thing.y
          ) {
            continue;
          }
          actions.push(createAction(state, thing));
        }
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

  private static removeFields(target: any, fieldsToRemove: any): void {
    for (const key in fieldsToRemove) {
      if (fieldsToRemove[key] instanceof Array) {
        for (const thingToRemove of fieldsToRemove[key]) {
          target[key] = target[key].filter((thing: Thing) => !(thingToRemove.id === thing.id));
        }
      } else if (typeof fieldsToRemove[key] === "object" && fieldsToRemove[key] !== null) {
        if (target[key]) {
          this.removeFields(target[key], fieldsToRemove[key]);
        }
      } else {
        delete target[key];
      }
    }
  }

  private static executeAction(action: Action, state: CombinedState): CombinedState {
    const newState = deepCloneWithActionReference(state);
    if (action.effects.toAdd) {
      this.mergeObjects(newState, action.effects.toAdd);
    }
    if (action.effects.toRemove) {
      this.removeFields(newState, action.effects.toRemove);
    }
    return newState;
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

  private static isBackAndForthWalk(currentNode: Node, targetId: string): boolean {
    let tempNode = currentNode;
    let actionHistory: string[] = [];
    let visitedLocations: Set<string> = new Set();

    while (tempNode.parent && actionHistory.length < 10) {
      if (tempNode.action) {
        actionHistory.push(tempNode.action.name);
        if (tempNode.action.name === "WalkTo") {
          visitedLocations.add(tempNode.action.target?.id || "");
        }
      }
      tempNode = tempNode.parent;
    }

    return actionHistory.every((action) => action === "WalkTo") && visitedLocations.has(targetId);
  }

  private static printActionSequence(currentNode: Node): string {
    let parentNode = currentNode;
    const actionSequence: string[] = [];

    while (parentNode.parent) {
      if (parentNode.action) {
        actionSequence.unshift(`${parentNode.action.name}(${parentNode.action.target?.name})`);
      }
      parentNode = parentNode.parent;
    }

    return `Action Sequence: ${actionSequence.join(" -> ")}`;
  }
  private static describeThings(state: CombinedState): string {
    return [
      ...state.things
        .filter((t) => t.id !== state.player.id)
        .map((t) => `${t.name} at (${t.x}, ${t.y})`),
      `Player at (${state.player.x}, ${state.player.y})`,
    ].join(", ");
  }

  private static describeActions(actions: Action[]): string {
    return actions.map((a) => `${a.name}(${a.target.name})`).join(", ");
  }
}

export { GOAPPlanner };
