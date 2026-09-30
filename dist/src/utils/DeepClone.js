"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.deepCloneWithActionReference = void 0;
const QuadTree_1 = require("./QuadTree");
// deepCloneWithActionReference.ts
function deepCloneWithActionReference(obj) {
    if (obj === null || typeof obj !== "object" || typeof obj === "function") {
        return obj;
    }
    if (obj instanceof QuadTree_1.QuadTree) {
        return obj.clone();
    }
    if (Array.isArray(obj)) {
        const arrCopy = [];
        for (const [index, value] of obj.entries()) {
            arrCopy[index] = deepCloneWithActionReference(value);
        }
        return arrCopy;
    }
    else {
        const objCopy = {};
        for (const [key, value] of Object.entries(obj)) {
            objCopy[key] = deepCloneWithActionReference(value);
        }
        return objCopy;
    }
}
exports.deepCloneWithActionReference = deepCloneWithActionReference;
exports.default = deepCloneWithActionReference;
//# sourceMappingURL=DeepClone.js.map