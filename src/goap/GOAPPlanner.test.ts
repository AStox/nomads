// GOAPPlanner.test.ts

import { GOAPPlanner, CombinedState } from "./GOAPPlanner";
import { Player } from "../Player";
import { WalkTo } from "./Actions/WalkTo";
import { WorldState } from "../World";
import { Goal } from "./Goals";
import { Action } from "./Action";
import { ThingType } from "../Things";

describe("GOAPPlanner", () => {
  // it("should make the player walk to the target position", () => {
  //   const player = new Player(ThingType.PLAYER, 0, 0, "🧍", [WalkTo]);
  //   const worldState: WorldState = { items: [], things: [] };
  //   const goal: Goal = { requirements: { x: 3, y: 3 }, requiredSkills: [], reward: "Go To" };
  //   const combinedState: CombinedState = { ...player.playerState, ...worldState };
  //   const availableActions: Action[] = [];
  //   const actionFactories = [WalkTo];
  //   let plan = GOAPPlanner.plan(
  //     player.playerState,
  //     worldState,
  //     goal,
  //     availableActions,
  //     actionFactories
  //   );
  //   expect(plan).not.toBeNull();
  //   // Loop to simulate turns
  //   for (let i = 0; i < 10; i++) {
  //     if (plan.length > 0) {
  //       const firstAction = plan[0];
  //       const success = firstAction.perform(); // Replace with appropriate agent
  //       if (success) {
  //         plan.shift();
  //         // Update the playerState to reflect the new position
  //       }
  //     }
  //   }
  //   // Validate the final state
  //   expect(player.x).toBe(3);
  //   expect(player.y).toBe(3);
  // });
});
