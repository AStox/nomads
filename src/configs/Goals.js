const { Skills } = require("./Skills");

const Goals = {
  CHEF: { requirements: [Skills.COOKING_3], reward: "Chef" },
  FIRE_STARTER: { requirements: [Skills.FIRE_MAKING_3], reward: "Fire Starter" },
};

module.exports = { Goals };
