const { Rectangle } = require("./World");

class Renderer {
  constructor(world) {
    this.world = world;
    this.gridSize = world.quadtree.boundary.w * 2;
  }

  // Convert the world's items to grid positions
  toGrid() {
    const grid = Array.from({ length: this.gridSize }, () => Array(this.gridSize).fill("."));
    const items = this.world.quadtree.query(new Rectangle(0, 0, this.gridSize, this.gridSize));

    for (const item of items) {
      const x = Math.floor(item.x + this.gridSize / 2);
      const y = Math.floor(item.y + this.gridSize / 2);
      if (x >= 0 && x < this.gridSize && y >= 0 && y < this.gridSize) {
        grid[y][x] = item.symbol; // "#" is a placeholder for an item
      }
    }

    return grid;
  }

  // Clear the terminal
  clearTerminal() {
    console.clear();
  }

  // Render the grid to the terminal
  render() {
    this.clearTerminal();
    const grid = this.toGrid();
    for (const row of grid) {
      console.log(row.join(" "));
    }
  }
}

module.exports = Renderer;
