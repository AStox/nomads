import { Rectangle } from "./World";

type WorldType = {
  quadtree: {
    boundary: {
      w: number;
    };
    query: (rect: Rectangle) => any[];
  };
};

class Renderer {
  world: WorldType;
  gridSize: number;

  constructor(world: WorldType) {
    this.world = world;
    this.gridSize = world.quadtree.boundary.w * 2;
  }

  toGrid(): string[][] {
    const grid = Array.from({ length: this.gridSize }, () => Array(this.gridSize).fill("."));
    const items = this.world.quadtree.query(new Rectangle(0, 0, this.gridSize, this.gridSize));

    for (const item of items) {
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
    // this.clearTerminal();
    const grid = this.toGrid();
    for (const row of grid) {
      console.log(row.join(" "));
    }
  }
}

export default Renderer;
