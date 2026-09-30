"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.omitFields = void 0;
function omitFields(obj, fields) {
    const newObj = {};
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
exports.omitFields = omitFields;
//# sourceMappingURL=omitFields.js.map