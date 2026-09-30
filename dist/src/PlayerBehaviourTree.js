"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createBehaviorTree = void 0;
const BaseNodes_1 = require("./behaviorTree/BaseNodes");
const SetGoal_1 = require("./behaviorTree/SetGoal");
const CheckLongGoals_1 = require("./behaviorTree/CheckLongGoals");
const CheckHP_1 = require("./behaviorTree/CheckHP");
const CheckHunger_1 = require("./behaviorTree/CheckHunger");
function createBehaviorTree(player) {
    return new BaseNodes_1.SelectorNode([
        new BaseNodes_1.SequenceNode([
            new CheckHP_1.CheckHP(player),
            new SetGoal_1.SetGoal(player, {
                requiredSkills: [],
                requirements: (state) => state.player.HP > 50,
            }),
        ]),
        new BaseNodes_1.SequenceNode([
            new CheckHunger_1.CheckHunger(player),
            new SetGoal_1.SetGoal(player, {
                requiredSkills: [],
                requirements: (state) => state.player.hunger > 50,
            }),
        ]),
        new BaseNodes_1.SelectorNode([
            new BaseNodes_1.SequenceNode([
                new CheckLongGoals_1.CheckLongGoals(player),
                new BaseNodes_1.SelectorNode([new BaseNodes_1.SequenceNode([new BaseNodes_1.LogNode("GOAP SYSTEM TAKES OVER")])]),
            ]),
            new BaseNodes_1.LogNode("Handle No Goals Flow"),
        ]),
    ]);
}
exports.createBehaviorTree = createBehaviorTree;
//# sourceMappingURL=PlayerBehaviourTree.js.map