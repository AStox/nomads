// deepCloneWithActionReference.ts
export function deepCloneWithActionReference<T>(obj: T): T {
  if (obj === null || typeof obj !== "object" || typeof obj === "function") {
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
      objCopy[key] = deepCloneWithActionReference(value);
    }
    return objCopy as T;
  }
}

export default deepCloneWithActionReference;
