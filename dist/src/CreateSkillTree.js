"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createSkillTree = void 0;
const SkillTree_1 = require("./SkillTree");
const Skills_1 = require("./configs/Skills");
function createSkillTree() {
    const skillTree = new SkillTree_1.SkillTree();
    const fireMaking1 = new SkillTree_1.SkillNode(Skills_1.Skills.FIRE_MAKING_1, 1, []);
    skillTree.addNode(fireMaking1);
    fireMaking1
        .addNext(new SkillTree_1.SkillNode(Skills_1.Skills.FIRE_MAKING_2, 2))
        .addNext(new SkillTree_1.SkillNode(Skills_1.Skills.FIRE_MAKING_3, 3));
    const fishing1 = new SkillTree_1.SkillNode(Skills_1.Skills.FISHING_1, 10, []);
    skillTree.addNode(fishing1);
    fishing1
        .addNext(new SkillTree_1.SkillNode(Skills_1.Skills.FISHING_2, 20))
        .addNext(new SkillTree_1.SkillNode(Skills_1.Skills.FISHING_3, 30));
    const cooking1 = new SkillTree_1.SkillNode(Skills_1.Skills.COOKING_1, 100, [fireMaking1]);
    skillTree.addNode(cooking1);
    cooking1
        .addNext(new SkillTree_1.SkillNode(Skills_1.Skills.COOKING_2, 200))
        .addNext(new SkillTree_1.SkillNode(Skills_1.Skills.COOKING_3, 300));
    return skillTree;
}
exports.createSkillTree = createSkillTree;
//# sourceMappingURL=CreateSkillTree.js.map