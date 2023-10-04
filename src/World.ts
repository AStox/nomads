import { QuadTree, Rectangle } from "./utils/QuadTree";
import { Player } from "./Player";
import { Item } from "./Items";
import fs from "fs";
import { Thing } from "./Things";

export interface WorldState {
  things: Thing[];
  items: Item[];
}
class World {
  state: WorldState = { things: [], items: [] };
  quadtree: QuadTree;

  constructor(width: number, height: number) {
    this.quadtree = new QuadTree(new Rectangle(0, 0, width / 2, height / 2), 4);
  }

  // addItem(item: Item) {
  //   this.state.items.push(item);
  //   this.quadtree.insert(item);
  // }

  addThing(thing: Thing) {
    this.state.things.push(thing);
    this.quadtree.insert(thing);
  }

  queryThingsInVision(player: Player): Thing[] {
    // const vision = player.getVision(); // TODO: Implement this
    const vision = new Rectangle(0, 0, 100, 100);
    return this.quadtree.query(vision);
  }
}

export { World, Rectangle, Thing };
