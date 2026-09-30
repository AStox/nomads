"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.LogNode = exports.NegateNode = exports.SequenceNode = exports.SelectorNode = exports.BehaviorNode = void 0;
const Logger_1 = __importDefault(require("../utils/Logger"));
class BehaviorNode {
}
exports.BehaviorNode = BehaviorNode;
class SelectorNode extends BehaviorNode {
    constructor(children) {
        super();
        this.children = children;
    }
    run(context) {
        for (const child of this.children) {
            if (child.run(context))
                return true;
        }
        return false;
    }
}
exports.SelectorNode = SelectorNode;
class SequenceNode extends BehaviorNode {
    constructor(children) {
        super();
        this.children = children;
    }
    run(context) {
        for (const child of this.children) {
            if (!child.run(context))
                return false;
        }
        return true;
    }
}
exports.SequenceNode = SequenceNode;
class NegateNode extends BehaviorNode {
    constructor(childNode) {
        super();
        this.childNode = childNode;
    }
    run(context) {
        return !this.childNode.run(context);
    }
}
exports.NegateNode = NegateNode;
class LogNode extends BehaviorNode {
    constructor(message) {
        super();
        this.message = message;
    }
    run(context) {
        Logger_1.default.log(this.message);
        return true;
    }
}
exports.LogNode = LogNode;
//# sourceMappingURL=BaseNodes.js.map