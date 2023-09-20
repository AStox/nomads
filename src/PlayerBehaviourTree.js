const { SelectorNode, SequenceNode, NegateNode, LogNode } = require("./behaviorTree/BaseNodes");
const { CheckLongGoals } = require("./behaviorTree/CheckLongGoals");
const { CheckHP } = require("./behaviorTree/CheckHP");
const { CheckHunger } = require("./behaviorTree/CheckHunger");

function createBehaviorTree(player) {
  return new SelectorNode([
    new SequenceNode([new CheckHP(player), new LogNode("Handle HP Low Flow")]),
    new SequenceNode([new CheckHunger(player), new LogNode("Handle Hunger Low Flow")]),
    new SelectorNode([
      new SequenceNode([new CheckLongGoals(player), new LogNode("Handle Long Goals Flow")]),
      new LogNode("Handle No Goals Flow"),
    ]),
  ]);
}

module.exports = { createBehaviorTree };
