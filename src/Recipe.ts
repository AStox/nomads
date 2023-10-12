import { Thing, ThingType, createThing } from "./Thing";
import { Craft } from "./goap/Actions/Craft";
import { PickUp } from "./goap/Actions/PickUp";
import { WalkTo } from "./goap/Actions/WalkTo";

interface Recipe {
  name: ThingType;
  ingredients: Ingredient[];
  result: Thing[];
  actions: Function[];
}

type Ingredient = Thing | ThingType;

const recipes: Recipe[] = [
  {
    name: ThingType.AXE,
    ingredients: [ThingType.WOOD, ThingType.STONE],
    result: [createThing(ThingType.AXE)],
    actions: [Craft],
  },
  {
    name: ThingType.HAMMER,
    ingredients: [ThingType.WOOD, ThingType.WOOD, ThingType.STONE],
    result: [createThing(ThingType.HAMMER)],
    actions: [Craft],
  },
];

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

    // Count occurrences of each ThingType or specific Thing in the recipe ingredients
    for (const ingredient of recipe.ingredients) {
      let ingredientKey: string;
      if (typeof ingredient === "object" && ingredient !== null) {
        ingredientKey = ingredient.id;
      } else {
        ingredientKey = ingredient;
      }
      if (!recipeCounts[ingredientKey]) {
        recipeCounts[ingredientKey] = 0;
      }
      recipeCounts[ingredientKey]++;
    }

    // Check if there are enough ingredients in the inventory for each type
    for (const [ingredientKey, quantity] of Object.entries(recipeCounts)) {
      if (!inventoryCounts[ingredientKey] || inventoryCounts[ingredientKey] < quantity) {
        return false;
      }
    }

    return true;
  });
}

export { getCraftableRecipes, Recipe, Ingredient };
