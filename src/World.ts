import { QuadTree, Rectangle } from "./utils/QuadTree";
import { Player } from "./Player";
import { Thing } from "./Thing";

export interface WorldState {
  quadtree: QuadTree;
}

class World {
  private static instance: World;
  state: WorldState;

  private constructor(width: number, height: number) {
    this.state = {
      quadtree: new QuadTree(new Rectangle(0, 0, width / 2, height / 2), 4),
    };
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
}

export { World, Rectangle, Thing };
