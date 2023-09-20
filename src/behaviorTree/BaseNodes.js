class BehaviorNode {
  run(context) {
    throw new Error("This method is abstract");
  }
}

class SelectorNode extends BehaviorNode {
  constructor(children) {
    super();
    this.children = children;
  }

  run(context) {
    for (const child of this.children) {
      if (child.run(context)) return true;
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
      if (!child.run(context)) return false;
    }
    return true;
  }
}

class NegateNode extends BehaviorNode {
  constructor(childNode) {
    super();
    this.childNode = childNode;
  }

  run(context) {
    return !this.childNode.run(context);
  }
}

class LogNode extends BehaviorNode {
  constructor(message) {
    super();
    this.message = message;
  }

  run(context) {
    console.log(this.message);
    return true;
  }
}

module.exports = { BehaviorNode, SelectorNode, SequenceNode, NegateNode, LogNode };
