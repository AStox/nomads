const { Point, Rectangle, QuadTree } = require("./QuadTree"); // Import your QuadTree classes

describe("QuadTree", () => {
  let boundary, qt;

  beforeEach(() => {
    boundary = new Rectangle(0, 0, 100, 100);
    qt = new QuadTree(boundary, 4);
  });

  test("Inserts points correctly", () => {
    const point = new Point(10, 10, null);
    qt.insert(point);
    expect(qt.points).toContain(point);
  });

  test("Splits when reaching capacity", () => {
    for (let i = 0; i < 5; i++) {
      qt.insert(new Point(i, i, null));
    }
    expect(qt.divided).toBe(true);
  });

  test("Query returns correct points", () => {
    const points = [new Point(10, 10, "a"), new Point(20, 20, "b"), new Point(90, 90, "c")];

    points.forEach((p) => qt.insert(p));

    const range = new Rectangle(15, 15, 30, 30);
    const found = [];
    qt.query(range, found);

    expect(found).toContain(points[0]);
    expect(found).toContain(points[1]);
    expect(found).not.toContain(points[2]);
  });
});
