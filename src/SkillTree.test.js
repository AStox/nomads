// SkillTree.test.js
const { SkillTree, SkillNode } = require("./SkillTree");
const fs = require("fs");

// Mock fs for testing loadFromConfig function
// jest.mock("fs");

describe("SkillTree", () => {
  let skillTree;

  beforeEach(() => {
    skillTree = new SkillTree("src/configs/SkillTreeConfig.json");
  });

  test("addSkill should add a new skill", () => {
    const node = skillTree.findNode("Firemaking_1");
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
    expect(node.isLearned).toBe(true);
  });
});
