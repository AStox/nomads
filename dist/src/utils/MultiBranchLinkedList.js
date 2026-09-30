"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MultiBranchLinkedList = exports.Node = void 0;
class Node {
    // manager: MultiBranchLinkedList | null = null;
    constructor(name, prevNodes = [], nextNodes = []) {
        this.name = name;
        this.prevNodes = prevNodes;
        this.nextNodes = nextNodes;
        this.achieved = false;
    }
    addPrev(node) {
        // if (!this.manager) {
        //   throw new Error("Node not added to manager.");
        // }
        if (this.prevNodes.includes(node)) {
            return node;
        }
        if (node.nextNodes.includes(this)) {
            return node;
        }
        // this.manager.nodes.push(node);
        node.nextNodes.push(this);
        this.prevNodes.push(node);
        // node.manager = this.manager;
        return node;
    }
    addNext(node) {
        // if (!this.manager) {
        //   throw new Error("Node not added to manager.");
        // }
        if (this.nextNodes.includes(node)) {
            return node;
        }
        if (node.prevNodes.includes(this)) {
            return node;
        }
        // this.manager.nodes.push(node);
        node.prevNodes.push(this);
        this.nextNodes.push(node);
        // node.manager = this.manager;
        return node;
    }
}
exports.Node = Node;
class MultiBranchLinkedList {
    constructor() {
        this.nodes = [];
    }
    addNode(node) {
        if (this.nodes.includes(node)) {
            return node;
        }
        // node.manager = this;
        this.nodes.push(node);
        return node;
    }
    findNode(name) {
        const foundNode = this.nodes.find((node) => node.name === name);
        if (!foundNode) {
            throw new Error(`Node with name ${name} not found.`);
        }
        return foundNode;
    }
    getFurthestPrev(startNode) {
        return this.getFurthest(startNode, "prevNodes");
    }
    getFurthestNext(startNode) {
        return this.getFurthest(startNode, "nextNodes");
    }
    getFurthest(startNode, direction) {
        const visited = new Set();
        const toVisit = [startNode];
        const furthest = [];
        while (toVisit.length) {
            const current = toVisit.pop();
            if (!current[direction].length) {
                furthest.push(current);
            }
            else {
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
exports.MultiBranchLinkedList = MultiBranchLinkedList;
//# sourceMappingURL=MultiBranchLinkedList.js.map