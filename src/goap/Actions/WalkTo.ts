import { Action } from "../Action";
import { CombinedState } from "../GOAPPlanner";
import { Goal } from "../Goals";

function WalkTo(state: CombinedState, goal: Goal): Action {
  // find the vector between the agent and the destination, normalize it and multiple by player speed
  console.log("STATE: ", state);
  const destination = { x: goal.requirements.x, y: goal.requirements.y };
  let newPlayerPosition: { x: number; y: number } = { x: state.x, y: state.y };
  if (destination.x !== undefined && destination.y !== undefined) {
    const dx = destination.x - state.x;
    const dy = destination.y - state.y;
    const length = Math.sqrt(dx * dx + dy * dy);
    const speed = state.speed;
    if (length > speed) {
      const normalizedVector = {
        dx: dx / length,
        dy: dy / length,
      };
      newPlayerPosition = {
        x: state.x + normalizedVector.dx * speed,
        y: state.y + normalizedVector.dy * speed,
      };
    } else {
      newPlayerPosition = { x: destination.x, y: destination.y };
    }
  }

  return {
    name: "WalkTo",
    cost: 1,
    preconditions: {},
    effects: { ...destination },

    perform(agent: any): boolean {
      console.log("Moving to: ", newPlayerPosition);
      return state.player.moveTo(newPlayerPosition.x, newPlayerPosition.y);
    },
  };
}

export { WalkTo };
