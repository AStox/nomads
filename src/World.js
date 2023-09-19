const { QuadTree, Rectangle, Point } = require("./utils/QuadTree"); // Assume you have a Quadtree implementation

class World {
  constructor() {
    this.quadtree = new Quadtree(new Rectangle(0, 0, 1000, 1000), 4);
    this.currentLocation = { x: 0, y: 0 };
  }

  addItem(item) {
    this.quadtree.insert(item);
  }

  getNearbyItems() {
    // Define a search area around the current location
    const searchArea = {
      x: this.currentLocation.x - 10,
      y: this.currentLocation.y - 10,
      width: 20,
      height: 20,
    };
    return this.quadtree.query(searchArea);
  }

  // Other methods to move the player, remove items, etc.
}

module.exports = World;
