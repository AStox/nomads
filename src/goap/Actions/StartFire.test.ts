import { Player } from "../../Player";
import { Thing, ThingType, createThing } from "../../Thing";
import { QuadTree, Rectangle } from "../../utils/QuadTree";
import { CombinedState } from "../GOAPPlanner";
import { StartFire } from "./StartFire";

let state: CombinedState;
let wood: Thing;
let player: Player;

beforeAll(() => {
  player = new Player("1", "John Plant", 0, 0, "🧍", []);
  wood = createThing(ThingType.WOOD, { x: 0, y: 0 });
  let berry = createThing(ThingType.BERRY, { x: 0, y: 1 });
  state = createState([player, wood, berry]);
});

const createState = (things: Thing[]): CombinedState => {
  return {
    things,
    quadtree: new QuadTree(new Rectangle(0, 0, 10, 10), 4),
    player: player,
  };
};

describe("StartFire", () => {
  it("should remove wood", () => {
    const action = StartFire(state, wood);
    const newState = action.perform(state);
    // expect newState to no longer contain wood
    expect(newState.things).not.toContain(wood);
    const quadtreeThings = newState.quadtree.queryAll();
    expect(quadtreeThings).not.toContain(wood);
  });
  it("should add a campfire", () => {
    const wood = createThing(ThingType.WOOD, { x: 0, y: 0 });
    const player = new Player("1", "John Plant", 0, 0, "🧍", []);
    const quadtree = new QuadTree(new Rectangle(0, 0, 10, 10), 4);
    const state: CombinedState = {
      things: [wood, player],
      quadtree: quadtree,
      player: player,
    };
    const action = StartFire(state, wood);
    const newState = action.perform(state);
    // expect newState to contain a campfire
    expect(newState.things).toContainEqual(
      expect.objectContaining({
        type: ThingType.CAMPFIRE,
      })
    );
    const quadtreeThings = newState.quadtree.queryAll();
    expect(quadtreeThings).toContainEqual(
      expect.objectContaining({
        type: ThingType.CAMPFIRE,
      })
    );
  });
  it("should not affect other objects", () => {
    const wood = createThing(ThingType.WOOD, { x: 0, y: 0 });
    const player = new Player("1", "John Plant", 0, 0, "🧍", []);
    const quadtree = new QuadTree(new Rectangle(0, 0, 10, 10), 4);
    const berry = createThing(ThingType.BERRY, { x: 0, y: 1 });
    const state: CombinedState = {
      things: [wood, player, berry],
      quadtree: quadtree,
      player: player,
    };
    state.quadtree.insert(berry);
    const action = StartFire(state, wood);
    const newState = action.perform(state);
    // expect newState to contain a campfire
    expect(newState.things).toContainEqual(
      expect.objectContaining({
        type: ThingType.BERRY,
      })
    );
    const quadtreeThings = newState.quadtree.queryAll();
    expect(quadtreeThings).toContainEqual(
      expect.objectContaining({
        type: ThingType.BERRY,
      })
    );
  });
});
