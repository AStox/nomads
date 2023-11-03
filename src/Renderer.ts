import { World } from "./World";
import { Action } from "./goap/Action";
import { CombinedState } from "./goap/GOAPPlanner";
import { SocketServer } from "./server/SocketServer";

class Renderer {
  socketServer: SocketServer;

  constructor() {
    this.socketServer = new SocketServer();
    this.socketServer.start(8080); // You can choose another port if 8080 is already in use
  }

  toGrid(state: CombinedState): string[][] {
    const gridSize = state.quadtree.boundary.w * 2;
    const grid = Array.from({ length: gridSize }, () => Array(gridSize).fill(". "));
    const items = state.quadtree.queryAll();

    for (const item of items) {
      const x = Math.floor(item.x + gridSize / 2);
      const y = Math.floor(item.y + gridSize / 2);
      if (x >= 0 && x < gridSize && y >= 0 && y < gridSize) {
        grid[y][x] = item.symbol;
      }
    }

    return grid;
  }

  render(state: CombinedState): void {
    const grid = this.toGrid(state);
    const gridString = grid.map((row) => row.join("")).join("\n");
    const statusString = `HP: ${state.player.HP}/${state.player.maxHP}\nHunger: ${
      state.player.hunger
    }/${state.player.maxHunger}\nInventory: ${
      state.player.inventory.map((item) => `${item.name}${item.symbol}`).join(", ") || []
    }\nPlan: ${
      state.player.currentPlan && state.player.currentPlan.length > 0
        ? state.player.currentPlan
            ?.map(
              (action: Action) => `${action.name}(${action.target.name}${action.target.symbol})`
            )
            .join(" -> ")
        : state.player.GOAPStatus
    }`;
    this.socketServer.send(gridString + "\n" + statusString);
  }
}

export default Renderer;
