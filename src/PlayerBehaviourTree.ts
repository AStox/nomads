import { SelectorNode, SequenceNode, NegateNode, LogNode } from "./behaviorTree/BaseNodes";
import { CheckLongGoals } from "./behaviorTree/CheckLongGoals";
import { CheckHP } from "./behaviorTree/CheckHP";
import { CheckHunger } from "./behaviorTree/CheckHunger";
import { Player } from "./Player"; // Assuming Player is a class you've defined

function createBehaviorTree(player: Player) {
  return new SelectorNode([
    new SequenceNode([new CheckHP(player), new LogNode("Handle HP Low Flow")]),
    new SequenceNode([new CheckHunger(player), new LogNode("Handle Hunger Low Flow")]),
    new SelectorNode([
      new SequenceNode([
        new CheckLongGoals(player),
        new SelectorNode([new SequenceNode([new LogNode("GOAP SYSTEM TAKES OVER")])]),
      ]),
      new LogNode("Handle No Goals Flow"),
    ]),
  ]);
}

export { createBehaviorTree };
