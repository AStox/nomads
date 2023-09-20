class BehaviorNode {
  run() {
    throw new Error("This method is abstract");
  }
}

class SelectorNode extends BehaviorNode {
  constructor(children) {
    super();
    this.children = children;
  }

  run() {
    for (const child of this.children) {
      if (child.run()) return true;
    }
    return false;
  }
}

class SequenceNode extends BehaviorNode {
  constructor(children) {
    super();
    this.children = children;
  }

  run(context) {
    for (const child of this.children) {
      if (!child.run()) return false;
    }
    return true;
  }
}

class NegateNode extends BehaviorNode {
  constructor(childNode) {
    super();
    this.childNode = childNode;
  }

  run() {
    return !this.childNode.run();
  }
}

class LogNode extends BehaviorNode {
  constructor(message) {
    super();
    this.message = message;
  }

  run() {
    console.log(this.message);
    return true;
  }
}

module.exports = { BehaviorNode, SelectorNode, SequenceNode, NegateNode, LogNode };
