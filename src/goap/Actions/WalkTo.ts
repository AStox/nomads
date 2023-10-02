import { Action } from "../Action";
import { CombinedState } from "../GOAPPlanner";
import { Goal } from "../Goals";

function WalkTo(state: CombinedState, goal: Goal): Action {
  // find the vector between the agent and the destination, normalize it and multiple by player speed
  const destination = { x: goal.requirements.x, y: goal.requirements.y };
  let newPlayerPosition: { x: number; y: number } = { x: state.x, y: state.y };
  if (destination.x !== undefined && destination.y !== undefined) {
    const dx = destination.x - state.x;
    const dy = destination.y - state.y;
    const length = Math.sqrt(dx * dx + dy * dy);
    const speed = state.speed;
    const normalizedVector = {
      dx: dx / length,
      dy: dy / length,
    };
    const newDx = normalizedVector.dx * speed;
    const newDy = normalizedVector.dy * speed;
    newPlayerPosition = { x: state.x + newDx, y: state.y + newDy };
  }

  return {
    name: "WalkTo",
    cost: 1,
    preconditions: {},
    effects: { ...destination },

    perform(agent: any): boolean {
      return state.player.moveTo(newPlayerPosition.x, newPlayerPosition.y);
    },
  };
}

export { WalkTo };
