class Node {
  name: string;
  prevNodes: Node[];
  nextNodes: Node[];
  achieved: boolean;
  manager: MultiBranchLinkedList | null = null;

  constructor(name: string, prevNodes: Node[] = [], nextNodes: Node[] = []) {
    this.name = name;
    this.prevNodes = prevNodes;
    this.nextNodes = nextNodes;
    this.achieved = false;
  }

  addPrev(node: Node): Node {
    if (!this.manager) {
      throw new Error("Node not added to manager.");
    }
    if (this.prevNodes.includes(node)) {
      return node;
    }
    if (node.nextNodes.includes(this)) {
      return node;
    }
    this.manager.nodes.push(node);
    node.nextNodes.push(this);
    this.prevNodes.push(node);
    node.manager = this.manager;
    return node;
  }

  addNext(node: Node): Node {
    if (!this.manager) {
      throw new Error("Node not added to manager.");
    }
    if (this.nextNodes.includes(node)) {
      return node;
    }
    if (node.prevNodes.includes(this)) {
      return node;
    }
    this.manager.nodes.push(node);
    node.prevNodes.push(this);
    this.nextNodes.push(node);
    node.manager = this.manager;
    return node;
  }
}

class MultiBranchLinkedList {
  nodes: Node[];

  constructor() {
    this.nodes = [];
  }

  addNode(node: Node): Node {
    if (this.nodes.includes(node)) {
      return node;
    }
    node.manager = this;
    this.nodes.push(node);
    return node;
  }

  findNode(name: string): Node {
    const foundNode = this.nodes.find((node) => node.name === name);
    if (!foundNode) {
      throw new Error(`Node with name ${name} not found.`);
    }
    return foundNode;
  }

  getFurthestPrev(startNode: Node): Node[] {
    return this.getFurthest(startNode, "prevNodes");
  }

  getFurthestNext(startNode: Node): Node[] {
    return this.getFurthest(startNode, "nextNodes");
  }

  private getFurthest(startNode: Node, direction: "prevNodes" | "nextNodes"): Node[] {
    const visited = new Set<Node>();
    const toVisit = [startNode];
    const furthest: Node[] = [];

    while (toVisit.length) {
      const current = toVisit.pop()!;
      if (!current[direction].length) {
        furthest.push(current);
      } else {
        current[direction].forEach((node) => {
          if (!visited.has(node)) {
            toVisit.push(node);
          }
        });
      }
      visited.add(current);
    }

    return furthest;
  }
}

export { Node, MultiBranchLinkedList };
