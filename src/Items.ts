enum ItemType {
  STONE = "STONE",
  STICK = "STICK",
  AXE = "AXE",
  HAMMER = "HAMMER",
  KNIFE = "KNIFE",
  FISH = "FISH",
  BERRY = "BERRY",
  MUSHROOM = "MUSHROOM",
  TENT = "TENT",
}

interface Item {
  name: string;
  type: ItemType;
  x: number;
  y: number;
  symbol: string;
  actions: Function[];
}

export { Item, ItemType };
