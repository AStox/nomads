const { QuadTree, Rectangle, Point } = require("./utils/QuadTree");
const fs = require("fs");

class World {
  constructor(width, height) {
    this.quadtree = new QuadTree(new Rectangle(0, 0, width / 2, height / 2), 4);
    this.currentLocation = { x: 0, y: 0 };
  }

  addItem(item) {
    this.quadtree.insert(item);
  }

  populateItemsFromConfig(filePath) {
    const rawData = fs.readFileSync(filePath);
    const itemConfigs = JSON.parse(rawData);

    for (let i = 0; i < this.quadtree.boundary.w; i++) {
      // Assuming you want to add 1000 random items
      const randomConfig = itemConfigs[Math.floor(Math.random() * itemConfigs.length)];
      const x = Math.random() * this.quadtree.boundary.w * 2 - this.quadtree.boundary.w; // x coordinate
      const y = Math.random() * this.quadtree.boundary.h * 2 - this.quadtree.boundary.h; // y coordinate

      this.quadtree.insert({ x, y, ...randomConfig });
    }
  }
}

module.exports = { World, Rectangle };
