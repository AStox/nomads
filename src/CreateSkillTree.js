const { SkillTree } = require("./SkillTree");
const { Skills } = require("./configs/Skills");

function createSkillTree() {
  return new SkillTree([
    {
      name: Skills.FIRE_MAKING_1,
      experienceCost: 1,
      prerequisites: [],
    },
    {
      name: Skills.FIRE_MAKING_2,
      experienceCost: 2,
      prerequisites: [Skills.FIRE_MAKING_1],
    },
    {
      name: Skills.FIRE_MAKING_3,
      experienceCost: 3,
      prerequisites: [Skills.FIRE_MAKING_2],
    },
    {
      name: Skills.FISHING_1,
      experienceCost: 10,
      prerequisites: [],
    },
    {
      name: Skills.FISHING_2,
      experienceCost: 20,
      prerequisites: [Skills.FISHING_1],
    },
    {
      name: Skills.FISHING_3,
      experienceCost: 30,
      prerequisites: [Skills.FISHING_2],
    },
    {
      name: Skills.COOKING_1,
      experienceCost: 100,
      prerequisites: [Skills.FIRE_MAKING_1],
    },
    {
      name: Skills.COOKING_2,
      experienceCost: 200,
      prerequisites: [Skills.COOKING_1],
    },
    {
      name: Skills.COOKING_3,
      experienceCost: 300,
      prerequisites: [Skills.COOKING_2],
    },
  ]);
}

module.exports = { createSkillTree };
