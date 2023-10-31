import { Rectangle, World } from "./World";
import { QuadTree } from "./utils/QuadTree";

type WorldType = {
  state: {
    quadtree: {
      boundary: {
        w: number;
      };
      query: (rect: Rectangle) => any[];
    };
  };
};

class Renderer {
  world: World;
  gridSize: number;

  constructor(world: World) {
    this.world = world;
    this.gridSize = world.state.quadtree.boundary.w * 2;
  }

  toGrid(): string[][] {
    const grid = Array.from({ length: this.gridSize }, () => Array(this.gridSize).fill(". "));
    const items = this.world.state.quadtree.queryAll();

    console.log(items.map((item) => item.name));

    for (const item of items) {
      console.log(item.name, item.x, item.y, item.symbol);
      const x = Math.floor(item.x + this.gridSize / 2);
      const y = Math.floor(item.y + this.gridSize / 2);
      if (x >= 0 && x < this.gridSize && y >= 0 && y < this.gridSize) {
        grid[y][x] = item.symbol;
      }
    }

    return grid;
  }

  clearTerminal(): void {
    console.clear();
  }

  render(): void {
    this.clearTerminal();
    const grid = this.toGrid();
    for (const row of grid) {
      console.log(row.join(""));
    }
  }
}

export default Renderer;
