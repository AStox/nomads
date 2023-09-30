import { SkillTree, SkillNode } from "./SkillTree";
import { Skills } from "./configs/Skills";

function createSkillTree(): SkillTree {
  const skillTree = new SkillTree();

  const fireMaking1 = new SkillNode(Skills.FIRE_MAKING_1, 1, []);
  skillTree.addNode(fireMaking1);
  fireMaking1
    .addNext(new SkillNode(Skills.FIRE_MAKING_2, 2))
    .addNext(new SkillNode(Skills.FIRE_MAKING_3, 3));
  const fishing1 = new SkillNode(Skills.FISHING_1, 10, []);
  skillTree.addNode(fishing1);
  fishing1
    .addNext(new SkillNode(Skills.FISHING_2, 20))
    .addNext(new SkillNode(Skills.FISHING_3, 30));
  const cooking1 = new SkillNode(Skills.COOKING_1, 100, [fireMaking1]);
  skillTree.addNode(cooking1);
  cooking1
    .addNext(new SkillNode(Skills.COOKING_2, 200))
    .addNext(new SkillNode(Skills.COOKING_3, 300));
  return skillTree;
}

export { createSkillTree };
