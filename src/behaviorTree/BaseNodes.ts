abstract class BehaviorNode {
  abstract run(context: any): boolean;
}

class SelectorNode extends BehaviorNode {
  private children: BehaviorNode[];

  constructor(children: BehaviorNode[]) {
    super();
    this.children = children;
  }

  run(context: any): boolean {
    for (const child of this.children) {
      if (child.run(context)) return true;
    }
    return false;
  }
}

class SequenceNode extends BehaviorNode {
  private children: BehaviorNode[];

  constructor(children: BehaviorNode[]) {
    super();
    this.children = children;
  }

  run(context: any): boolean {
    for (const child of this.children) {
      if (!child.run(context)) return false;
    }
    return true;
  }
}

class NegateNode extends BehaviorNode {
  private childNode: BehaviorNode;

  constructor(childNode: BehaviorNode) {
    super();
    this.childNode = childNode;
  }

  run(context: any): boolean {
    return !this.childNode.run(context);
  }
}

class LogNode extends BehaviorNode {
  private message: string;

  constructor(message: string) {
    super();
    this.message = message;
  }

  run(context: any): boolean {
    console.log(this.message);
    return true;
  }
}

export { BehaviorNode, SelectorNode, SequenceNode, NegateNode, LogNode };
