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
  name: ItemType;
  x: number;
  y: number;
  symbol: string;
}

export { Item, ItemType };
