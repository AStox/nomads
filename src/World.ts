import { QuadTree, Rectangle } from "./utils/QuadTree";
import { Player } from "./Player";
import fs from "fs";
import { Thing } from "./Thing";

export interface WorldState {
  things: Thing[];
}

class World {
  private static instance: World;
  state: WorldState = { things: [] };
  quadtree: QuadTree;

  private constructor(width: number, height: number) {
    this.quadtree = new QuadTree(new Rectangle(0, 0, width / 2, height / 2), 4);
  }

  public static newWorld(width: number, height: number): World {
    if (World.instance) {
      return World.instance;
    }
    World.instance = new World(width, height);
    return World.instance;
  }

  public static getInstance(): World {
    if (!World.instance) {
      World.instance = new World(100, 100);
    }
    return World.instance;
  }

  addThing(thing: Thing) {
    this.state.things.push(thing);
    this.quadtree.insert(thing);
  }

  removeThing(thing: Thing) {
    this.state.things = this.state.things.filter((t) => t.id !== thing.id);
    this.quadtree.remove(thing);
  }

  queryThingsInVision(player: Player): Thing[] {
    // const vision = player.getVision(); // TODO: Implement this
    const vision = new Rectangle(0, 0, 100, 100);
    return this.quadtree.query(vision);
  }
}

export { World, Rectangle, Thing };
