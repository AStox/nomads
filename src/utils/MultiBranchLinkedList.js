class Node {
  constructor(value) {
    this.value = value;
    this.prevNodes = [];
    this.nextNodes = [];
  }

  addPrev(node) {
    this.prevNodes.push(node);
  }

  addNext(node) {
    this.nextNodes.push(node);
  }
}

class MultiBranchLinkedList {
  constructor() {
    this.nodes = [];
  }

  addNode(value) {
    const node = new Node(value);
    this.nodes.push(node);
    return node;
  }

  findNode(value) {
    const foundNode = this.nodes.find((node) => node.value === value);
    if (!foundNode) {
      throw new Error(`Node with value ${value} not found.`);
    }
    return foundNode;
  }

  getFurthestPrev(startNode) {
    const visited = new Set();
    const toVisit = [startNode];
    const furthestPrev = [];

    while (toVisit.length) {
      const current = toVisit.pop();
      if (!current.prevNodes.length) {
        furthestPrev.push(current);
      } else {
        current.prevNodes.forEach((prev) => {
          if (!visited.has(prev)) {
            toVisit.push(prev);
          }
        });
      }
      visited.add(current);
    }

    return furthestPrev;
  }

  getFurthestNext(startNode) {
    const visited = new Set();
    const toVisit = [startNode];
    const furthestNext = [];

    while (toVisit.length) {
      const current = toVisit.pop();
      if (!current.nextNodes.length) {
        furthestNext.push(current);
      } else {
        current.nextNodes.forEach((next) => {
          if (!visited.has(next)) {
            toVisit.push(next);
          }
        });
      }
      visited.add(current);
    }

    return furthestNext;
  }
}

module.exports = { Node, MultiBranchLinkedList };
