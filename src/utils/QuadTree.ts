import { Thing } from "../World";

class Rectangle {
  x: number;
  y: number;
  w: number;
  h: number;

  constructor(x: number, y: number, w: number, h: number) {
    this.x = x;
    this.y = y;
    this.w = w;
    this.h = h;
  }

  contains(thing: Thing): boolean {
    return (
      thing.x >= this.x - this.w &&
      thing.x < this.x + this.w &&
      thing.y >= this.y - this.h &&
      thing.y < this.y + this.h
    );
  }

  intersects(range: Rectangle): boolean {
    return !(
      range.x - range.w > this.x + this.w ||
      range.x + range.w < this.x - this.w ||
      range.y - range.h > this.y + this.h ||
      range.y + range.h < this.y - this.h
    );
  }
}

class QuadTree {
  boundary: Rectangle;
  capacity: number;
  things: Thing[];
  divided: boolean;
  northeast?: QuadTree;
  northwest?: QuadTree;
  southeast?: QuadTree;
  southwest?: QuadTree;

  constructor(boundary: Rectangle, capacity: number) {
    this.boundary = boundary;
    this.capacity = capacity;
    this.things = [];
    this.divided = false;
  }

  subdivide() {
    let x = this.boundary.x;
    let y = this.boundary.y;
    let w = this.boundary.w / 2;
    let h = this.boundary.h / 2;

    let ne = new Rectangle(x + w, y - h, w, h);
    this.northeast = new QuadTree(ne, this.capacity);
    let nw = new Rectangle(x - w, y - h, w, h);
    this.northwest = new QuadTree(nw, this.capacity);
    let se = new Rectangle(x + w, y + h, w, h);
    this.southeast = new QuadTree(se, this.capacity);
    let sw = new Rectangle(x - w, y + h, w, h);
    this.southwest = new QuadTree(sw, this.capacity);

    this.divided = true;
  }

  insert(thing: Thing): boolean {
    if (!this.boundary.contains(thing)) {
      return false;
    }

    if (this.things.length < this.capacity) {
      this.things.push(thing);
      return true;
    }

    if (!this.divided) {
      this.subdivide();
    }

    return (
      this.northeast!.insert(thing) ||
      this.northwest!.insert(thing) ||
      this.southeast!.insert(thing) ||
      this.southwest!.insert(thing)
    );
  }

  query(range: Rectangle | any, found?: Thing[]): Thing[] {
    if (!(range instanceof Rectangle)) {
      if (
        range.x === undefined ||
        range.y === undefined ||
        range.w === undefined ||
        range.h === undefined
      ) {
        throw new Error("range must be of type Rectangle or have properties x, y, w, h");
      }
      range = new Rectangle(range.x, range.y, range.w, range.h);
    }
    if (!found) found = [];

    if (!this.boundary.intersects(range)) {
      return found;
    }

    for (let p of this.things) {
      if (range.contains(p)) {
        found.push(p);
      }
    }

    if (this.divided) {
      this.northeast!.query(range, found);
      this.northwest!.query(range, found);
      this.southeast!.query(range, found);
      this.southwest!.query(range, found);
    }

    return found;
  }
}

export { Rectangle, QuadTree };
