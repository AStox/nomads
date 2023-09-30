import { Node, MultiBranchLinkedList } from "./utils/MultiBranchLinkedList";

class SkillNode extends Node {
  experienceCost: number;
  experienceSpent: number;

  constructor(
    name: string,
    experienceCost: number,
    prevNodes: Node[] = [],
    nextNodes: Node[] = []
  ) {
    super(name, prevNodes, nextNodes);
    this.experienceCost = experienceCost;
    this.experienceSpent = 0;
  }

  learn(): void {
    if (this.achieved) {
      throw new Error(`Skill ${this.name} already learned.`);
    }

    const prerequisites = this.prevNodes.map((node) => node.name);
    for (const prereqNode of this.prevNodes) {
      if (!prereqNode.achieved) {
        throw new Error(`Need to learn ${prerequisites.join(", ")} first.`);
      }
    }

    if (this.experienceSpent < this.experienceCost) {
      throw new Error(
        `Not enough experience. ${this.experienceCost - this.experienceSpent} more needed.`
      );
    }

    this.achieved = true;
  }

  spendExperience(amount: number): string {
    if (this.achieved) {
      throw new Error(`Skill ${this.name} already learned.`);
    }

    const prerequisites = this.prevNodes.filter((node) => !node.achieved).map((node) => node.name);
    if (prerequisites.length) {
      return `Need to learn ${prerequisites.join(", ")} first.`;
    }

    this.experienceSpent += amount;
    if (this.experienceSpent >= this.experienceCost) {
      this.learn();
      return `Skill ${this.name} learned.`;
    }
    return `Experience spent. ${this.experienceCost - this.experienceSpent} more needed.`;
  }
}

class SkillTree extends MultiBranchLinkedList {
  constructor() {
    super();
  }

  findNode(name: string): SkillNode {
    return super.findNode(name) as SkillNode;
  }
}

export { SkillTree, SkillNode };
