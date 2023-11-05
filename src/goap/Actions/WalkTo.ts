import { Thing } from "../../Thing";
import { Action } from "../Action";
import { CombinedState, GOAPPlanner } from "../GOAPPlanner";

function WalkTo(state: CombinedState, thing: Thing): Action {
  return {
    name: "WalkTo",
    target: thing,
    cost: 1,
    actionFilter: (state: CombinedState) => {
      return GOAPPlanner.generateActions(state, []).filter((action) => action.name !== "WalkTo");
    },
    preconditions: (state: CombinedState) => {
      return true;
    },

    simulate(state: CombinedState) {
      let player = state.quadtree.queryAll().find((t) => t.id === state.player.id);
      if (player) {
        state.quadtree.remove(player as Thing);
        state.quadtree.insert({ ...state.player, x: thing.x, y: thing.y });
      }
      return state;
    },
    perform(state: CombinedState) {
      // return state.player.moveTo(newPlayerPosition.x, newPlayerPosition.y);
      // state.player.x = destination.x;
      // state.player.y = destination.y;
      let player = state.quadtree.queryAll().find((t) => t.id === state.player.id);
      if (player) {
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
            newPlayerPosition = { x: thing.x, y: thing.y };
          }
        }
        state.quadtree.remove(player as Thing);
        state.quadtree.insert({ ...state.player, x: newPlayerPosition.x, y: newPlayerPosition.y });
      }
      return state;
    },
  };
}

export { WalkTo };
