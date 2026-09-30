"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.deepEqual = void 0;
const deepEqual = (a, b) => {
    if (a === b)
        return true;
    if (a && b && typeof a === "object" && typeof b === "object") {
        if (Array.isArray(a)) {
            if (a.length !== b.length)
                return false;
            for (let i = 0; i < a.length; i++) {
                if (!(0, exports.deepEqual)(a[i], b[i]))
                    return false;
            }
            return true;
        }
        const keys = Object.keys(a);
        if (keys.length !== Object.keys(b).length)
            return false;
        for (const key of keys) {
            if (!b.hasOwnProperty(key))
                return false;
            if (!(0, exports.deepEqual)(a[key], b[key]))
                return false;
        }
        return true;
    }
    return false;
};
exports.deepEqual = deepEqual;
//# sourceMappingURL=DeepEqual.js.map