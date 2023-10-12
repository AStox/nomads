import { Thing, ThingType } from "../Thing";
import { Rectangle, QuadTree } from "./QuadTree";

describe("QuadTree", () => {
  let boundary: Rectangle;
  let qt: QuadTree;

  beforeEach(() => {
    boundary = new Rectangle(0, 0, 100, 100);
    qt = new QuadTree(boundary, 4);
  });

  test("Inserts points correctly", () => {
    const point = {
      id: "fish1",
      name: ThingType.FISH,
      type: ThingType.FISH,
      x: 10,
      y: 10,
      symbol: "*",
      actions: [],
    };
    qt.insert(point);
    expect(qt.things).toContain(point);
  });

  test("Splits when reaching capacity", () => {
    for (let i = 0; i < 5; i++) {
      const point = {
        id: "fish1",
        name: ThingType.FISH,
        type: ThingType.FISH,
        x: 10 * i,
        y: 10 * i,
        symbol: "*",
        actions: [],
      };
      qt.insert(point);
    }
    expect(qt.divided).toBe(true);
  });

  test("Query returns correct points", () => {
    const points = [
      {
        id: "fish1",
        name: ThingType.FISH,
        type: ThingType.FISH,
        x: 10,
        y: 10,
        symbol: "a",
        actions: [],
      },
      {
        id: "fish2",
        name: ThingType.FISH,
        type: ThingType.FISH,
        x: 20,
        y: 20,
        symbol: "b",
        actions: [],
      },
      {
        id: "fish3",
        name: ThingType.FISH,
        type: ThingType.FISH,
        x: 90,
        y: 90,
        symbol: "c",
        actions: [],
      },
    ];

    points.forEach((p) => qt.insert(p));

    const range = new Rectangle(15, 15, 30, 30);
    const found: Thing[] = [];
    qt.query(range, found);

    expect(found).toContain(points[0]);
    expect(found).toContain(points[1]);
    expect(found).not.toContain(points[2]);
  });
});
