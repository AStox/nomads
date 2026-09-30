"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const Thing_1 = require("../Thing");
const QuadTree_1 = require("./QuadTree");
describe("QuadTree", () => {
    let boundary;
    let qt;
    beforeEach(() => {
        boundary = new QuadTree_1.Rectangle(0, 0, 100, 100);
        qt = new QuadTree_1.QuadTree(boundary, 4);
    });
    test("Inserts points correctly", () => {
        const point = {
            id: "fish1",
            name: Thing_1.ThingType.FISH,
            type: Thing_1.ThingType.FISH,
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
                name: Thing_1.ThingType.FISH,
                type: Thing_1.ThingType.FISH,
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
                name: Thing_1.ThingType.FISH,
                type: Thing_1.ThingType.FISH,
                x: 10,
                y: 10,
                symbol: "a",
                actions: [],
            },
            {
                id: "fish2",
                name: Thing_1.ThingType.FISH,
                type: Thing_1.ThingType.FISH,
                x: 20,
                y: 20,
                symbol: "b",
                actions: [],
            },
            {
                id: "fish3",
                name: Thing_1.ThingType.FISH,
                type: Thing_1.ThingType.FISH,
                x: 90,
                y: 90,
                symbol: "c",
                actions: [],
            },
        ];
        points.forEach((p) => qt.insert(p));
        const range = new QuadTree_1.Rectangle(15, 15, 30, 30);
        const found = [];
        qt.query(range, found);
        expect(found).toContain(points[0]);
        expect(found).toContain(points[1]);
        expect(found).not.toContain(points[2]);
    });
});
//# sourceMappingURL=QuadTree.test.js.map