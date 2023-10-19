import { Player, playerState } from "../Player";
import { Thing, ThingType } from "../Thing";
import { WorldState } from "../World";
import { Action } from "./Action";
import { Goal } from "./Goals";
import { omitFields } from "../utils/omitFields";
import { deepCloneWithActionReference } from "../utils/DeepClone";
import { deepEqual } from "../utils/DeepEqual";
import { getCraftableRecipes } from "../Recipe";
import { Craft } from "./Actions/Craft";

let DEBUG = false;

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
    let plans: Action[][] = [];

    while (nodes.length > 0) {
      DEBUG = false;
      // Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);

      sequenceCount++;
      nodes.sort((a, b) => a.cost - b.cost);
      const currentNode = nodes.shift()!;
      const sequence = this.getActionSequence(currentNode);
      const pattern = [
        // "Drop(STONE)",
        "PickUp(WOOD)",
        // "WalkTo(STONE)",
        // "PickUp(STONE)",
        // "Craft(AXE)",
        // "WalkTo(TREE)",
        // "Chop(TREE)",
        // "PickUp(WOOD)",
      ];

      // if (this.isSequenceFollowingPattern(sequence, pattern)) {
      // DEBUG = true;
      // }
      DEBUG = true;
      // ----------------- DEBUG -----------------
      if (!DEBUG && sequenceCount % 10 === 0) {
        console.log(sequenceCount);
      }
      if (DEBUG) {
        console.log(
          `\n=================== Considered Sequence ${sequenceCount} ======================\n`
        );
        console.log("GOAL:", goal.requirements.toString());
        console.log(this.printActionSequence(currentNode));
        console.log("");
        // print things
        console.log("THINGS:", this.describeThings(currentNode.state.things));
        console.log(
          "INVENTORY:",
          this.describeThings(currentNode.state.player.inventory as Thing[])
        );
        // console.log(`Player's Inventory:`, currentNode.state.player.inventory);
      }
      // ----------------- DEBUG -----------------

      let availableActions = this.generateActions(currentNode.state, globalActions);
      availableActions.sort((a, b) => a.cost - b.cost);
      if (DEBUG) {
        console.log("AVAILABLE ACTIONS: ", this.describeActions(availableActions));
        console.log("");
      }

      // if (DEBUG) console.log("CURRENT NODE STATE:", currentNode.state);
      for (const action of availableActions) {
        if (this.isActionExecutable(action, currentNode.state)) {
          if (action.name === "WalkTo" && currentNode.action?.name === "WalkTo") {
            if (DEBUG)
              console.log(
                `Action not executed: ${action.name}(${action.target.name}) Consecutive WalkTo action.`
              );
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
          if (this.isStateInAncestry(newNode)) {
            if (DEBUG)
              console.log(
                `Action not executed: ${action.name}(${action.target.name}) Duplicate state.`
              );
            continue;
          }
          // Log actions taken and the resulting state
          if (DEBUG) console.log(`Action executed: ${action.name}(${action.target?.name})`);
          if (this.goalMet(goal, newNode.state)) {
            console.log("Goal met! Reconstructing plan...");

            let node = newNode;
            while (node.parent) {
              if (node.action) {
                plan.unshift(node.action);
              }
              node = node.parent;
            }
            if (DEBUG) {
              console.log("\x1b[32m");
              console.log("\nPlan found!");
              console.log("Plan:", this.describeActions(plan));
              console.log("");
              console.log("\x1b[0m");
            }
            plans.push([...plan]);
            plan = [];
          }

          if (plans.length < 1) nodes.push(newNode);
        } else {
          if (DEBUG) console.log(`Action not executed: ${action.name}(${action.target.name})`);
        }
      }
    }
    if (DEBUG) {
      console.log("\n================== FINISHED PLAN GENERATION =====================\n");
    }
    if (plans.length > 0) {
      // choose the plan with the lowest cost
      let lowestCost = Number.MAX_SAFE_INTEGER;
      let lowestCostPlan: Action[] = [];
      for (const plan of plans) {
        let cost = 0;
        for (const action of plan) {
          cost += action.cost;
        }
        if (cost < lowestCost) {
          lowestCost = cost;
          lowestCostPlan = plan;
        }
      }
      console.log("Total plans:", plans.length);
      console.log(
        "Plans:",
        plans.map((p) => p.map((a) => `${a.name}(${a.target.name})`).join(" -> ")).join("\n")
      );
      return lowestCostPlan;
    }
    console.log("No valid plan found.");
    return [];
  }

  private static generateActions(state: CombinedState, globalActions: Function[]): Action[] {
    let actions: Action[] = [];

    // Add crafting actions
    const craftableRecipes = getCraftableRecipes(state.player.inventory);
    if (DEBUG)
      console.log(
        "CRAFTABLE RECIPES: ",
        craftableRecipes.map((r) => r.name)
      );
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
          // exclude drop actions because player isn't holding the object
          if (createAction.name === "Drop") {
            continue;
          }
          actions.push(createAction(state, thing));
        }
      }
    }
    for (const thing of state.player.inventory) {
      for (const createAction of thing.actions) {
        // exclude walkTo and pickUp actions because player is already holding the object
        if (createAction.name === "WalkTo" || createAction.name === "PickUp") {
          continue;
        }
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
      if (Array.isArray(source[key])) {
        target[key] = [...(target[key] || []), ...(source[key] || [])];
        continue;
      }
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
          if (typeof thingToRemove == "object") {
            const index = target[key].findIndex((thing: Thing) => thingToRemove.id === thing.id);
            if (index !== -1) {
              target[key].splice(index, 1);
            }
          } else {
            const index = target[key].findIndex((thing: Thing) => thingToRemove === thing.type);
            if (index !== -1) {
              target[key].splice(index, 1);
            }
          }
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
    let newState = deepCloneWithActionReference(state);
    return action.perform(newState);
    // if (action.effects.toAdd) {
    //   this.mergeObjects(newState, action.effects.toAdd);
    // }
    // if (action.effects.toRemove) {
    //   this.removeFields(newState, action.effects.toRemove);
    // }
    // return newState;
  }

  private static goalMet(goal: Goal, state: CombinedState): boolean {
    return goal.requirements(state);
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
    requiredThings: (Thing | ThingType)[],
    playerInventory: Thing[]
  ): boolean {
    const thingCounts = new Map<ThingType, number>();
    const thingInstances = new Set<Thing>();

    // Count how many things of each type the player has
    Object.values(playerInventory).forEach((thing) => {
      thingCounts.set(thing.type, (thingCounts.get(thing.type) || 0) + 1);
      thingInstances.add(thing);
    });

    // Check if each required item type or item instance is met
    for (const requiredThing of requiredThings) {
      if (typeof requiredThing === "object") {
        if (!thingInstances.has(requiredThing as Thing)) {
          return false;
        }
        thingInstances.delete(requiredThing as Thing);
      } else {
        const count = thingCounts.get(requiredThing as ThingType) || 0;
        if (count <= 0) {
          return false;
        }
        thingCounts.set(requiredThing as ThingType, count - 1);
      }
    }

    return true;
  }

  // ----------------- HELPERS -----------------

  private static isStateInAncestry(node: Node): boolean {
    let currentNode = node;
    const targetState = node.state;

    while (currentNode.parent) {
      currentNode = currentNode.parent;
      if (deepEqual(currentNode.state, targetState)) {
        return true;
      }
    }

    return false;
  }

  private static getActionSequence(node: Node): string[] {
    const actions: string[] = [];
    let currentNode = node;
    while (currentNode.parent) {
      if (currentNode.action) {
        actions.unshift(`${currentNode.action.name}(${currentNode.action.target?.name})`);
      }
      currentNode = currentNode.parent;
    }
    return actions;
  }

  private static isSequenceFollowingPattern(sequence: string[], pattern: string[]): boolean {
    let patternIndex = 0;
    for (const action of sequence) {
      if (action === pattern[patternIndex]) {
        patternIndex++;
        if (patternIndex === pattern.length) {
          return true;
        }
      }
    }
    return false;
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
  private static describeThings(state: Thing[]): string {
    return [...state.map((t) => `${t.name}[${t.actions.map((a) => a.name).join(", ")}]`)].join(
      ", "
    );
  }

  private static describeActions(actions: Action[]): string {
    return actions.map((a) => `${a.name}(${a.target.name})`).join(", ");
  }
}

export { GOAPPlanner };
