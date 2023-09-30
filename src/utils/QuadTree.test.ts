import { Rectangle, QuadTree } from "./QuadTree";
import { Thing } from "../World";

describe("QuadTree", () => {
  let boundary: Rectangle;
  let qt: QuadTree;

  beforeEach(() => {
    boundary = new Rectangle(0, 0, 100, 100);
    qt = new QuadTree(boundary, 4);
  });

  test("Inserts points correctly", () => {
    const point = new Thing(10, 10, "*");
    qt.insert(point);
    expect(qt.things).toContain(point);
  });

  test("Splits when reaching capacity", () => {
    for (let i = 0; i < 5; i++) {
      qt.insert(new Thing(i, i, "*"));
    }
    expect(qt.divided).toBe(true);
  });

  test("Query returns correct points", () => {
    const points = [new Thing(10, 10, "a"), new Thing(20, 20, "b"), new Thing(90, 90, "c")];

    points.forEach((p) => qt.insert(p));

    const range = new Rectangle(15, 15, 30, 30);
    const found: Thing[] = [];
    qt.query(range, found);

    expect(found).toContain(points[0]);
    expect(found).toContain(points[1]);
    expect(found).not.toContain(points[2]);
  });
});
