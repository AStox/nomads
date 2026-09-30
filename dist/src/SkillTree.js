"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SkillNode = exports.SkillTree = void 0;
const MultiBranchLinkedList_1 = require("./utils/MultiBranchLinkedList");
class SkillNode extends MultiBranchLinkedList_1.Node {
    constructor(name, experienceCost, prevNodes = [], nextNodes = []) {
        super(name, prevNodes, nextNodes);
        this.experienceCost = experienceCost;
        this.experienceSpent = 0;
    }
    learn() {
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
            throw new Error(`Not enough experience. ${this.experienceCost - this.experienceSpent} more needed.`);
        }
        this.achieved = true;
    }
    spendExperience(amount) {
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
exports.SkillNode = SkillNode;
class SkillTree extends MultiBranchLinkedList_1.MultiBranchLinkedList {
    constructor() {
        super();
    }
    findNode(name) {
        return super.findNode(name);
    }
}
exports.SkillTree = SkillTree;
//# sourceMappingURL=SkillTree.js.map