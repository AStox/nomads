export function deepCloneWithActionReference<T>(obj: T): T {
  if (obj === null || typeof obj !== "object") {
    return obj;
  }
  if (Array.isArray(obj)) {
    const arrCopy = [] as any;
    for (const [index, value] of obj.entries()) {
      arrCopy[index] = deepCloneWithActionReference(value);
    }
    return arrCopy as T;
  } else {
    const objCopy = {} as any;
    for (const [key, value] of Object.entries(obj)) {
      if (key === "actions") {
        objCopy[key] = value;
      } else {
        objCopy[key] = deepCloneWithActionReference(value);
      }
    }
    return objCopy as T;
  }
}

export default deepCloneWithActionReference;
