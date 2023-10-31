// File: src/Renderer.ts
import { World } from "./World";
import { SocketServer } from "./server/SocketServer";

class Renderer {
  world: World;
  gridSize: number;
  socketServer: SocketServer;

  constructor(world: World) {
    this.world = world;
    this.gridSize = world.state.quadtree.boundary.w * 2;
    this.socketServer = new SocketServer();
    this.socketServer.start(8080); // You can choose another port if 8080 is already in use
  }

  toGrid(): string[][] {
    const grid = Array.from({ length: this.gridSize }, () => Array(this.gridSize).fill(". "));
    const items = this.world.state.quadtree.queryAll();

    for (const item of items) {
      const x = Math.floor(item.x + this.gridSize / 2);
      const y = Math.floor(item.y + this.gridSize / 2);
      if (x >= 0 && x < this.gridSize && y >= 0 && y < this.gridSize) {
        grid[y][x] = item.symbol;
      }
    }

    return grid;
  }

  render(): void {
    const grid = this.toGrid();
    const gridString = grid.map((row) => row.join("")).join("\n");
    this.socketServer.send(gridString);
  }
}

export default Renderer;
