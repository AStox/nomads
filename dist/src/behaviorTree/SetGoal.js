"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SetGoal = void 0;
const Logger_1 = __importDefault(require("../utils/Logger"));
const BaseNodes_1 = require("./BaseNodes");
class SetGoal extends BaseNodes_1.BehaviorNode {
    constructor(player, goal) {
        super();
        this.player = player;
        this.goal = goal;
    }
    run(context) {
        Logger_1.default.log("Setting goal.");
        this.player.currentGoal = this.goal;
        return true;
    }
}
exports.SetGoal = SetGoal;
//# sourceMappingURL=SetGoal.js.map