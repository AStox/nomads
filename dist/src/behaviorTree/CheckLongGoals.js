"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CheckLongGoals = void 0;
const Logger_1 = __importDefault(require("../utils/Logger"));
const BaseNodes_1 = require("./BaseNodes");
class CheckLongGoals extends BaseNodes_1.BehaviorNode {
    constructor(player) {
        // specify the player type if you have one
        super();
        this.player = player;
    }
    run(context) {
        // specify the context type if you have one
        if (this.player.longGoals.length > 0) {
            const index = Math.floor(context.rng * this.player.longGoals.length);
            this.player.currentGoal = this.player.longGoals[index];
            Logger_1.default.log("Player has longterm goals. Goal: " + this.player.currentGoal.reward);
            return true;
        }
        Logger_1.default.log("Player has no longterm goals.");
        return false;
    }
}
exports.CheckLongGoals = CheckLongGoals;
//# sourceMappingURL=CheckLongGoals.js.map