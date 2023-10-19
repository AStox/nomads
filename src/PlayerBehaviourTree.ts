import { SelectorNode, SequenceNode, NegateNode, LogNode } from "./behaviorTree/BaseNodes";
import { SetGoal } from "./behaviorTree/SetGoal";
import { CheckLongGoals } from "./behaviorTree/CheckLongGoals";
import { CheckHP } from "./behaviorTree/CheckHP";
import { CheckHunger } from "./behaviorTree/CheckHunger";
import { Player } from "./Player"; // Assuming Player is a class you've defined
import { Goal } from "./goap/Goals";
import { CombinedState } from "./goap/GOAPPlanner";
import { ThingType } from "./Thing";

function createBehaviorTree(player: Player) {
  return new SelectorNode([
    new SequenceNode([new CheckHP(player), new LogNode("HUNGER FLOW")]),
    new SequenceNode([
      new CheckHunger(player),
      new SetGoal(player, {
        requiredSkills: [],
        requirements: (state: CombinedState) => state.player.hunger > 50,
      } as Goal),
    ]),
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
