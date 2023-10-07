export function omitFields<T extends object>(obj: T, fields: string[]): Partial<T> {
  const newObj: Partial<T> = {};
  for (const key of Object.keys(obj)) {
    if (!fields.includes(key)) {
      // @ts-ignore
      newObj[key] = obj[key];
    }
  }
  for (const key of Object.getOwnPropertyNames(Object.getPrototypeOf(obj))) {
    if (key !== "constructor" && !fields.includes(key)) {
      // @ts-ignore
      newObj[key] = obj[key].bind(obj);
    }
  }
  return newObj;
}
