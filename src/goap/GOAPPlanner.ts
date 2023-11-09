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
import logger from "../utils/Logger";
import { compareByProximity, removeDuplicatesByType } from "../utils/removeDuplicates";

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
      logger.log("Goal already met. No actions needed.");
      return plan;
    }

    let nodes: Node[] = [startNode];
    logger.log("Starting plan generation...");

    let sequenceCount = 0;
    let plans: Action[][] = [];

    let nodesSinceLastPlan = 0;

    while (nodes.length > 0 && nodesSinceLastPlan < 1000) {
      if (plans.length > 0) {
        nodesSinceLastPlan += 1;
      }
      //   Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);

      sequenceCount++;
      nodes.sort((a, b) => a.cost - b.cost);
      const currentNode = nodes.shift()!;

      // ----------------- DEBUG -----------------
      if (sequenceCount % 10 === 0) {
        const status = `thinking... (${sequenceCount} sequences${
          plans.length > 0 ? `, elapsed: ${nodesSinceLastPlan}` : ""
        })`;
        currentNode.state.player.GOAPStatus = status;
        process.stdout.write(`\r${status}`);
      }
      logger.log(
        `\n=================== Considered Sequence ${sequenceCount} ======================\n`,
        false
      );
      logger.log(`GOAL: ${goal.requirements.toString()}`, false);
      logger.log(this.printActionSequence(currentNode), false);
      logger.log(
        `\nPLAYER: ${currentNode.state.quadtree.queryAll().find((t) => t.type === "PLAYER")?.x} ${
          currentNode.state.quadtree.queryAll().find((t) => t.type === "PLAYER")?.y
        }`,
        false
      );
      logger.log(`THINGS: ${this.describeThings(currentNode.state.quadtree.queryAll())}`, false);
      logger.log(
        `INVENTORY: [${this.describeThings(currentNode.state.player.inventory as Thing[])}]`,
        false
      );
      // ----------------- DEBUG -----------------

      let availableActions =
        currentNode.action?.actionFilter(currentNode.state) ||
        this.generateActions(currentNode.state, globalActions);
      availableActions.sort((a, b) => a.cost - b.cost);
      logger.log(`AVAILABLE ACTIONS: ${this.describeActions(availableActions)}\n`, false);

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
          // if (this.isStateInAncestry(newNode)) {
          //   // TODO: I dont think this was working
          //     logger.log(
          //       `Action not executed: ${action.name}(${action.target.name}) Duplicate state.`, false
          //     );
          //   continue;
          // }
          logger.log(`Action executed: ${action.name}(${action.target?.name})`, false);
          if (this.goalMet(goal, newNode.state)) {
            let node = newNode;
            while (node.parent) {
              if (node.action) {
                plan.unshift(node.action);
              }
              node = node.parent;
            }
            logger.log("\x1b[32m");
            logger.log("\nPlan found!");
            logger.log(`Plan: ${this.describeActions(plan)}\n`);
            logger.log("\x1b[0m");
            plans.push([...plan]);
            plan = [];
          }

          if (plans.length < 1) nodes.push(newNode);
        } else {
          logger.log(`Action not executed: ${action.name}(${action.target.name})`, false);
        }
      }
    }
    logger.log("\n================== FINISHED PLAN GENERATION =====================\n", false);
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
      logger.log(`Total plans: ${plans.length}`);
      logger.log(`Total sequences: ${sequenceCount}`);
      plans.forEach((plan, index) => {
        const planCost = plan.reduce((acc, action) => acc + action.cost, 0);
        logger.log(
          `${index + 1}. ${plan
            .map((a) => `${a.name}(${a.target.name})`)
            .join(" -> ")} - Cost: ${planCost}`
        );
      });
      return lowestCostPlan;
    }
    logger.log("No valid plan found.");
    return [];
  }

  static generateActions(state: CombinedState, globalActions: Function[]): Action[] {
    let actions: Action[] = [];
    // Add crafting actions
    const craftableRecipes = getCraftableRecipes(state);
    logger.log(`CRAFTABLE RECIPES: ${craftableRecipes.map((r) => r.name)}`, false);
    const craftActions: Action[] = craftableRecipes.map((recipe) => {
      // Return a new Craft action initialized with the recipe.
      // Replace `Craft` with the actual Craft action class you have.
      return Craft(state, recipe);
    });

    actions = [...actions, ...craftActions];

    const things = state.quadtree.queryAll();
    const player = things.find((t) => t.id === state.player.id) as Thing;
    const deduplicatedThings = removeDuplicatesByType(
      things,
      compareByProximity.bind(null, player)
    );
    for (const thing of deduplicatedThings) {
      if (thing.id !== state.player.id) {
        // Skip player
        for (const createAction of thing.actions) {
          // exclude walkto action if player is already at the thing
          const player = state.quadtree.queryAll().find((t) => t.id === state.player.id) as Thing;
          if (createAction.name === "WalkTo" && player.x === thing.x && player.y === thing.y) {
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
    // return this.matchesNestedKeys(action.preconditions, state);
    return action.preconditions(state);
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

  private static executeAction(action: Action, state: CombinedState): CombinedState {
    let newState = deepCloneWithActionReference(state);
    return action.simulate ? action.simulate(newState) : action.perform(newState);
  }

  private static goalMet(goal: Goal, state: CombinedState): boolean {
    return goal.requirements(state);
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
