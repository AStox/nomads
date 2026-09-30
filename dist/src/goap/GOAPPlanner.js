"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.GOAPPlanner = void 0;
const omitFields_1 = require("../utils/omitFields");
const DeepClone_1 = require("../utils/DeepClone");
const DeepEqual_1 = require("../utils/DeepEqual");
const Recipe_1 = require("../Recipe");
const Craft_1 = require("./Actions/Craft");
const Logger_1 = __importDefault(require("../utils/Logger"));
const removeDuplicates_1 = require("../utils/removeDuplicates");
class GOAPPlanner {
    static plan(player, worldState, goal, globalActions) {
        var _a, _b, _c, _d;
        let plan = [];
        const combinedState = Object.assign(Object.assign({}, worldState), { player: (0, omitFields_1.omitFields)(player, ["skillTree", "behaviorTree"]) });
        // Initialize the starting node
        const startNode = { parent: null, action: null, state: combinedState, cost: 0 };
        // Early return if goal is already met
        if (this.goalMet(goal, combinedState)) {
            Logger_1.default.log("Goal already met. No actions needed.");
            return plan;
        }
        let nodes = [startNode];
        Logger_1.default.log("Starting plan generation...");
        let sequenceCount = 0;
        let plans = [];
        let nodesSinceLastPlan = 0;
        while (nodes.length > 0 && nodesSinceLastPlan < 1000) {
            if (plans.length > 0) {
                nodesSinceLastPlan += 1;
            }
            //   Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
            sequenceCount++;
            nodes.sort((a, b) => a.cost - b.cost);
            const currentNode = nodes.shift();
            // ----------------- DEBUG -----------------
            if (sequenceCount % 10 === 0) {
                const status = `thinking... (${sequenceCount} sequences${plans.length > 0 ? `, elapsed: ${nodesSinceLastPlan}` : ""})`;
                currentNode.state.player.GOAPStatus = status;
                process.stdout.write(`\r${status}`);
            }
            Logger_1.default.log(`\n=================== Considered Sequence ${sequenceCount} ======================\n`, false);
            Logger_1.default.log(`GOAL: ${goal.requirements.toString()}`, false);
            Logger_1.default.log(this.printActionSequence(currentNode), false);
            Logger_1.default.log(`\nPLAYER: ${(_a = currentNode.state.quadtree.queryAll().find((t) => t.type === "PLAYER")) === null || _a === void 0 ? void 0 : _a.x} ${(_b = currentNode.state.quadtree.queryAll().find((t) => t.type === "PLAYER")) === null || _b === void 0 ? void 0 : _b.y}`, false);
            Logger_1.default.log(`THINGS: ${this.describeThings(currentNode.state.quadtree.queryAll())}`, false);
            Logger_1.default.log(`INVENTORY: [${this.describeThings(currentNode.state.player.inventory)}]`, false);
            // ----------------- DEBUG -----------------
            let availableActions = ((_c = currentNode.action) === null || _c === void 0 ? void 0 : _c.actionFilter(currentNode.state)) ||
                this.generateActions(currentNode.state, globalActions);
            availableActions.sort((a, b) => a.cost - b.cost);
            Logger_1.default.log(`AVAILABLE ACTIONS: ${this.describeActions(availableActions)}\n`, false);
            for (const action of availableActions) {
                if (this.isActionExecutable(action, currentNode.state)) {
                    const newState = this.executeAction(action, currentNode.state);
                    const newCost = currentNode.cost + action.cost;
                    const newNode = {
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
                    Logger_1.default.log(`Action executed: ${action.name}(${(_d = action.target) === null || _d === void 0 ? void 0 : _d.name})`, false);
                    if (this.goalMet(goal, newNode.state)) {
                        let node = newNode;
                        while (node.parent) {
                            if (node.action) {
                                plan.unshift(node.action);
                            }
                            node = node.parent;
                        }
                        Logger_1.default.log("\x1b[32m");
                        Logger_1.default.log("\nPlan found!");
                        Logger_1.default.log(`Plan: ${this.describeActions(plan)}\n`);
                        Logger_1.default.log("\x1b[0m");
                        plans.push([...plan]);
                        plan = [];
                    }
                    if (plans.length < 1)
                        nodes.push(newNode);
                }
                else {
                    Logger_1.default.log(`Action not executed: ${action.name}(${action.target.name})`, false);
                }
            }
        }
        Logger_1.default.log("\n================== FINISHED PLAN GENERATION =====================\n", false);
        if (plans.length > 0) {
            // choose the plan with the lowest cost
            let lowestCost = Number.MAX_SAFE_INTEGER;
            let lowestCostPlan = [];
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
            Logger_1.default.log(`Total plans: ${plans.length}`);
            Logger_1.default.log(`Total sequences: ${sequenceCount}`);
            plans.forEach((plan, index) => {
                const planCost = plan.reduce((acc, action) => acc + action.cost, 0);
                Logger_1.default.log(`${index + 1}. ${plan
                    .map((a) => `${a.name}(${a.target.name})`)
                    .join(" -> ")} - Cost: ${planCost}`);
            });
            return lowestCostPlan;
        }
        Logger_1.default.log("No valid plan found.");
        return [];
    }
    static generateActions(state, globalActions) {
        let actions = [];
        // Add crafting actions
        const craftableRecipes = (0, Recipe_1.getCraftableRecipes)(state);
        Logger_1.default.log(`CRAFTABLE RECIPES: ${craftableRecipes.map((r) => r.name)}`, false);
        const craftActions = craftableRecipes.map((recipe) => {
            // Return a new Craft action initialized with the recipe.
            // Replace `Craft` with the actual Craft action class you have.
            return (0, Craft_1.Craft)(state, recipe);
        });
        actions = [...actions, ...craftActions];
        const things = state.quadtree.queryAll();
        const player = things.find((t) => t.id === state.player.id);
        const deduplicatedThings = (0, removeDuplicates_1.removeDuplicatesByType)(things, removeDuplicates_1.compareByProximity.bind(null, player));
        for (const thing of deduplicatedThings) {
            if (thing.id !== state.player.id) {
                // Skip player
                for (const createAction of thing.actions) {
                    // exclude walkto action if player is already at the thing
                    const player = state.quadtree.queryAll().find((t) => t.id === state.player.id);
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
    static isActionExecutable(action, state) {
        // return this.matchesNestedKeys(action.preconditions, state);
        return action.preconditions(state);
    }
    static deepClone(obj, hash = new WeakMap()) {
        if (Object(obj) !== obj)
            return obj;
        if (hash.has(obj))
            return hash.get(obj);
        const result = Array.isArray(obj)
            ? []
            : obj.constructor
                ? new obj.constructor()
                : Object.create(null);
        hash.set(obj, result);
        return Object.assign(result, ...Object.keys(obj).map((key) => ({ [key]: this.deepClone(obj[key], hash) })));
    }
    static executeAction(action, state) {
        let newState = (0, DeepClone_1.deepCloneWithActionReference)(state);
        return action.simulate ? action.simulate(newState) : action.perform(newState);
    }
    static goalMet(goal, state) {
        return goal.requirements(state);
    }
    // ----------------- HELPERS -----------------
    static isStateInAncestry(node) {
        let currentNode = node;
        const targetState = node.state;
        while (currentNode.parent) {
            currentNode = currentNode.parent;
            if ((0, DeepEqual_1.deepEqual)(currentNode.state, targetState)) {
                return true;
            }
        }
        return false;
    }
    static printActionSequence(currentNode) {
        var _a;
        let parentNode = currentNode;
        const actionSequence = [];
        while (parentNode.parent) {
            if (parentNode.action) {
                actionSequence.unshift(`${parentNode.action.name}(${(_a = parentNode.action.target) === null || _a === void 0 ? void 0 : _a.name})`);
            }
            parentNode = parentNode.parent;
        }
        return `Action Sequence: ${actionSequence.join(" -> ")}`;
    }
    static describeThings(state) {
        return [...state.map((t) => `${t.name}[${t.actions.map((a) => a.name).join(", ")}]`)].join(", ");
    }
    static describeActions(actions) {
        return actions.map((a) => `${a.name}(${a.target.name})`).join(", ");
    }
}
exports.GOAPPlanner = GOAPPlanner;
//# sourceMappingURL=GOAPPlanner.js.map