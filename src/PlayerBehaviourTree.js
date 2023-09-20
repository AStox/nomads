const { SelectorNode, SequenceNode, NegateNode, LogNode } = require("./behaviorTree/BaseNodes");
const { CheckLongGoals } = require("./behaviorTree/CheckLongGoals");
const { CheckHP } = require("./behaviorTree/CheckHP");
const { CheckHunger } = require("./behaviorTree/CheckHunger");
const {
  GetEarliestUnearnedGoalRequirement,
} = require("./behaviorTree/GetEarliestUnearnedGoalRequirement");

function createBehaviorTree(player) {
  return new SelectorNode([
    new SequenceNode([new CheckHP(player), new LogNode("Handle HP Low Flow")]),
    new SequenceNode([new CheckHunger(player), new LogNode("Handle Hunger Low Flow")]),
    new SelectorNode([
      new SequenceNode([
        new CheckLongGoals(player),
        new SelectorNode([
          new SequenceNode([
            new GetEarliestUnearnedGoalRequirement(player),
            new LogNode("Handle got earliest requirement flow"),
          ]),
        ]),
      ]),
      new LogNode("Handle No Goals Flow"),
    ]),
  ]);
}

module.exports = { createBehaviorTree };
