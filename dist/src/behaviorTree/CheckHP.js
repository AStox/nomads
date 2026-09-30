"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CheckHP = void 0;
const Logger_1 = __importDefault(require("../utils/Logger"));
const BaseNodes_1 = require("./BaseNodes");
class CheckHP extends BaseNodes_1.BehaviorNode {
    constructor(player) {
        // specify the player type if you have one
        super();
        this.player = player;
    }
    run(context) {
        // specify the context type if you have one
        if (this.player.HP < this.player.HPActionThreshold) {
            Logger_1.default.log("HP below threshold.");
            return true;
        }
        Logger_1.default.log("HP Okay.");
        return false;
    }
}
exports.CheckHP = CheckHP;
//# sourceMappingURL=CheckHP.js.map