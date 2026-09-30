"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.Player = void 0;
const PlayerBehaviourTree_1 = require("./PlayerBehaviourTree");
const GOAPPlanner_1 = require("./goap/GOAPPlanner");
const WalkTo_1 = require("./goap/Actions/WalkTo");
const Thing_1 = require("./Thing");
const Logger_1 = __importDefault(require("./utils/Logger"));
class Player {
    // skillTree: SkillTree;
    constructor(id, name, x, y, symbol, actions) {
        this.id = id;
        this.name = name;
        this.type = Thing_1.ThingType.PLAYER;
        this.x = x;
        this.y = y;
        this.symbol = "🧍";
        this.actions = actions;
        this.speed = 2;
        this.inventory = [(0, Thing_1.createThing)(Thing_1.ThingType.AXE), (0, Thing_1.createThing)(Thing_1.ThingType.SAW)];
        this.hunger = 20;
        this.maxHunger = 100;
        this.hungerActionThreshold = 25;
        this.HP = 90;
        this.maxHP = 100;
        this.HPActionThreshold = 50;
        this.longGoals = [
            {
                requiredSkills: [],
                requirements: (state) => state.player.inventory.some((item) => item.type === Thing_1.ThingType.BERRY),
            },
        ];
        this.currentGoal = null;
        this.currentPlan = null;
        this.GOAPStatus = "idle";
        // this.skillTree = createSkillTree();
    }
    makeDecision(state) {
        const context = { rng: 0 };
        const behaviorTree = (0, PlayerBehaviourTree_1.createBehaviorTree)(this);
        behaviorTree.run(context);
        let actionFactories = [WalkTo_1.WalkTo];
        if (this.currentGoal) {
            if (!this.currentPlan ||
                this.currentPlan.length === 0 ||
                !this.currentPlan[0].preconditions(state)
            //   // this.hasCompletedAction(state, this.currentPlan)
            ) {
                this.currentPlan = GOAPPlanner_1.GOAPPlanner.plan(this, state, this.currentGoal, actionFactories);
            }
            Logger_1.default.log("\n~~Plan~~");
            for (let i = 0; i < this.currentPlan.length; i++) {
                Logger_1.default.log(`${i + 1}. ${this.currentPlan[i].name}(${this.currentPlan[i].target.name})[${this.currentPlan[i].target.id}]}]`);
            }
        }
        Logger_1.default.log("~~Execute Action~~");
        if (this.currentPlan && this.currentPlan.length > 0) {
            const action = this.currentPlan[0];
            if (action.preconditions(state)) {
                action.perform(state);
            }
            if (this.hasCompletedAction(state, this.currentPlan)) {
                this.currentPlan.shift();
            }
            Logger_1.default.log(`${action.name}(${action.target.name})`);
        }
    }
    hasCompletedAction(state, plan) {
        var _a;
        // console.log("!!!!!!!!!!!!!!!!!! has completed action");
        // console.log("plan length", plan.length);
        if (plan.length > 0) {
            if (plan.length > 1) {
                // console.log("plan[1].name", plan[1].name, plan[1].target.name);
                // console.log("plan[1].preconditions(state);", plan[1].preconditions(state));
                return plan[1].preconditions(state);
            }
            else {
                return (_a = this.currentGoal) === null || _a === void 0 ? void 0 : _a.requirements(state);
            }
        }
        return true;
    }
}
exports.Player = Player;
//# sourceMappingURL=Player.js.map