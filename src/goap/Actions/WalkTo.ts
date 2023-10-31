import { Thing } from "../../Thing";
import { Action } from "../Action";
import { CombinedState, GOAPPlanner } from "../GOAPPlanner";

function WalkTo(state: CombinedState, thing: Thing): Action {
  // find the vector between the agent and the destination, normalize it and multiple by player speed
  const player = state.quadtree.queryAll().find((t) => t.id === state.player.id) as Thing;
  const destination = { x: thing.x, y: thing.y };
  let newPlayerPosition: { x: number; y: number } = { x: player.x, y: player.y };
  if (destination.x !== undefined && destination.y !== undefined) {
    const dx = destination.x - player.x;
    const dy = destination.y - player.y;
    const length = Math.sqrt(dx * dx + dy * dy);
    const speed = state.player.speed;
    if (length > speed) {
      const normalizedVector = {
        dx: dx / length,
        dy: dy / length,
      };
      newPlayerPosition = {
        x: player.x + normalizedVector.dx * speed,
        y: player.y + normalizedVector.dy * speed,
      };
    } else {
      newPlayerPosition = { x: destination.x, y: destination.y };
    }
  }

  return {
    name: "WalkTo",
    target: thing,
    cost: 1,
    actionFilter: (state: CombinedState) => {
      return GOAPPlanner.generateActions(state, []);
    },
    preconditions: (state: CombinedState) => {
      return true;
    },

    simulate(state: CombinedState) {
      if (state.quadtree.queryAll().find((t) => t.id === state.player.id)) {
        state.quadtree.remove(state.player);
        state.quadtree.insert({ ...state.player, x: destination.x, y: destination.y });
      }
      return state;
    },
    perform(state: CombinedState) {
      // return state.player.moveTo(newPlayerPosition.x, newPlayerPosition.y);
      // state.player.x = destination.x;
      // state.player.y = destination.y;
      if (state.quadtree.queryAll().find((t) => t.id === state.player.id)) {
        state.quadtree.remove(state.player);
        state.quadtree.insert({ ...state.player, x: newPlayerPosition.x, y: newPlayerPosition.y });
      }
      return state;
    },
  };
}

export { WalkTo };
