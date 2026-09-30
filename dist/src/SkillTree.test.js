"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const SkillTree_1 = require("./SkillTree");
const CreateSkillTree_1 = require("./CreateSkillTree");
describe("SkillTree", () => {
    let skillTree;
    beforeEach(() => {
        skillTree = (0, CreateSkillTree_1.createSkillTree)();
    });
    test("addNode should add a new skill", () => {
        const newSkill = new SkillTree_1.SkillNode("new skill", 10);
        skillTree.addNode(newSkill);
        const node = skillTree.findNode("new skill");
        expect(node).not.toBeNull();
    });
    test("spendExperience should work correctly", () => {
        const node = skillTree.findNode("Fishing_1");
        const result = node.spendExperience(5);
        expect(result).toBe("Experience spent. 5 more needed.");
    });
    test("learn should work correctly", () => {
        const node = skillTree.findNode("Firemaking_1");
        const result = node.spendExperience(1);
        expect(result).toBe("Skill Firemaking_1 learned.");
        expect(node.achieved).toBe(true);
    });
});
//# sourceMappingURL=SkillTree.test.js.map