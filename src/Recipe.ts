import { Thing, ThingType } from "./Things";
import { Craft } from "./goap/Actions/Craft";
import { PickUp } from "./goap/Actions/PickUp";
import { WalkTo } from "./goap/Actions/WalkTo";

interface Recipe {
  name: ThingType;
  ingredients: ThingType[];
  result: Thing[];
  actions: Function[];
}

const recipes: Recipe[] = [
  {
    name: ThingType.AXE,
    ingredients: [ThingType.WOOD, ThingType.STONE],
    result: [
      {
        id: "axe1",
        name: ThingType.AXE,
        type: ThingType.AXE,
        x: 0,
        y: 0,
        symbol: "🪓",
        actions: [WalkTo, PickUp],
      },
    ],
    actions: [Craft],
  },
  {
    name: ThingType.HAMMER,
    ingredients: [ThingType.WOOD, ThingType.STONE],
    result: [
      {
        id: "hammer1",
        name: ThingType.HAMMER,
        type: ThingType.HAMMER,
        x: 0,
        y: 0,
        symbol: "🔨",
        actions: [WalkTo, PickUp],
      },
    ],
    actions: [Craft],
  },
];

// Assuming Recipe and ThingType are imported from their respective modules
function getCraftableRecipes(inventory: Thing[]): Recipe[] {
  const inventoryCounts: Record<string, number> = {};

  // Count occurrences of each ThingType in the inventory
  for (const item of inventory) {
    if (!inventoryCounts[item.type]) {
      inventoryCounts[item.type] = 0;
    }
    inventoryCounts[item.type]++;
  }

  // Now filter the recipes
  return recipes.filter((recipe) => {
    const recipeCounts: Record<string, number> = {};

    // Count occurrences of each ThingType in the recipe ingredients
    for (const ingredient of recipe.ingredients) {
      if (!recipeCounts[ingredient]) {
        recipeCounts[ingredient] = 0;
      }
      recipeCounts[ingredient]++;
    }

    // Check if there are enough ingredients in the inventory for each type
    for (const [ingredient, quantity] of Object.entries(recipeCounts)) {
      if (!inventoryCounts[ingredient] || inventoryCounts[ingredient] < quantity) {
        return false;
      }
    }

    return true;
  });
}

export { getCraftableRecipes, Recipe };
