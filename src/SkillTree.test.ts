import { SkillTree, SkillNode } from "./SkillTree";
import { createSkillTree } from "./CreateSkillTree";

describe("SkillTree", () => {
  let skillTree: SkillTree;

  beforeEach(() => {
    skillTree = createSkillTree();
  });

  test("addNode should add a new skill", () => {
    const newSkill = new SkillNode("new skill", 10);
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
