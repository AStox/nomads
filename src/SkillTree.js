const { Node, MultiBranchLinkedList } = require("./utils/MultiBranchLinkedList");
const fs = require("fs");

class SkillNode extends Node {
  constructor(value, experienceCost) {
    super(value);
    this.isLearned = false;
    this.experienceCost = experienceCost;
    this.experienceSpent = 0;
  }

  learn() {
    if (this.isLearned) {
      throw new Error(`Skill ${this.value} already learned.`);
    }

    const prerequisites = this.prevNodes.map((node) => node.value);
    for (const prereqNode of this.prevNodes) {
      if (!prereqNode.isLearned) {
        throw new Error(`Need to learn ${prerequisites.join(", ")} first.`);
      }
    }

    if (this.experienceSpent < this.experienceCost) {
      throw new Error(
        `Not enough experience. ${this.experienceCost - this.experienceSpent} more needed.`
      );
    }

    this.isLearned = true;
  }

  spendExperience(amount) {
    if (this.isLearned) {
      throw new Error(`Skill ${this.value} already learned.`);
    }

    // check if all prerequisites are learned
    const prerequisites = this.prevNodes
      .filter((node) => !node.isLearned)
      .map((node) => node.value);
    if (prerequisites.length) {
      return `Need to learn ${prerequisites.join(", ")} first.`;
    }

    this.experienceSpent += amount;
    if (this.experienceSpent >= this.experienceCost) {
      this.learn();
      return `Skill ${this.value} learned.`;
    }
    return `Experience spent. ${this.experienceCost - this.experienceSpent} more needed.`;
  }
}

class SkillTree extends MultiBranchLinkedList {
  constructor(object) {
    super();
    this.loadFromObject(object);
  }

  loadFromObject(skillObject) {
    skillObject.forEach((skill) => {
      this.addSkill(skill.name, skill.experienceCost, skill.prerequisites);
    });
  }

  addSkill(value, experienceCost, prerequisites = []) {
    const skillNode = new SkillNode(value, experienceCost);
    this.nodes.push(skillNode);

    prerequisites.forEach((prereq) => {
      const prereqNode = this.findNode(prereq);
      if (prereqNode) {
        prereqNode.addNext(skillNode);
        skillNode.addPrev(prereqNode);
      }
    });

    return skillNode;
  }

  findSkill(value) {
    const foundSkill = this.nodes.find((node) => node.value.skill === value);
    if (!foundSkill) {
      throw new Error(`Skill with name ${value} not found.`);
    }
    return foundSkill;
  }
}

module.exports = { SkillTree, SkillNode };
