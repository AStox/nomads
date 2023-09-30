import { QuadTree, Rectangle } from "./utils/QuadTree";
import { Player } from "./Player";
import fs from "fs";

class Thing {
  x: number;
  y: number;
  symbol: string;

  constructor(x: number, y: number, symbol: string) {
    this.x = x;
    this.y = y;
    this.symbol = symbol;
  }
}

class World {
  quadtree: QuadTree;

  constructor(width: number, height: number) {
    this.quadtree = new QuadTree(new Rectangle(0, 0, width / 2, height / 2), 4);
  }

  addThing(thing: Thing) {
    this.quadtree.insert(thing);
  }

  queryThingsInVision(player: Player): Thing[] {
    // const vision = player.getVision(); // TODO: Implement this
    const vision = new Rectangle(0, 0, 100, 100);
    return this.quadtree.query(vision);
  }

  populateThingsFromConfig(filePath: string) {
    const rawData = fs.readFileSync(filePath);
    const itemConfigs = JSON.parse(rawData as any);

    for (let i = 0; i < this.quadtree.boundary.w / 10; i++) {
      const randomConfig = itemConfigs[Math.floor(Math.random() * itemConfigs.length)];
      const x = Math.random() * this.quadtree.boundary.w * 2 - this.quadtree.boundary.w; // x coordinate
      const y = Math.random() * this.quadtree.boundary.h * 2 - this.quadtree.boundary.h; // y coordinate

      this.quadtree.insert({ x, y, ...randomConfig });
    }
  }
}

export { World, Rectangle, Thing };
