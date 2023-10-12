import { Item } from "../../Items";
import { Thing } from "../../Thing";
import { Action } from "../Action";
import { CombinedState } from "../GOAPPlanner";
import { Goal } from "../Goals";

function WalkTo(state: CombinedState, thing: Thing): Action {
  // find the vector between the agent and the destination, normalize it and multiple by player speed
  const destination = { x: thing.x, y: thing.y };
  let newPlayerPosition: { x: number; y: number } = { x: state.player.x, y: state.player.y };
  if (destination.x !== undefined && destination.y !== undefined) {
    const dx = destination.x - state.player.x;
    const dy = destination.y - state.player.y;
    const length = Math.sqrt(dx * dx + dy * dy);
    const speed = state.player.speed;
    if (length > speed) {
      const normalizedVector = {
        dx: dx / length,
        dy: dy / length,
      };
      newPlayerPosition = {
        x: state.player.x + normalizedVector.dx * speed,
        y: state.player.y + normalizedVector.dy * speed,
      };
    } else {
      newPlayerPosition = { x: destination.x, y: destination.y };
    }
  }

  return {
    name: "WalkTo",
    target: thing,
    cost: 1,
    preconditions: {},
    effects: { toAdd: { player: { ...destination } } },

    perform(): boolean {
      return state.player.moveTo(newPlayerPosition.x, newPlayerPosition.y);
    },
  };
}

export { WalkTo };
