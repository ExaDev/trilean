import { complexFromPolar } from "./complex";
import type { ComputedValue } from "./computed-value";
import type {
  BooleanLiteralNode,
  ComplexLiteralNode,
  DurationLiteralNode,
  InstantLiteralNode,
  NumberLiteralNode,
  TextLiteralNode,
} from "./tree";

/** Every expression node kind that is a constant: it evaluates to a value without consulting a resolver or any other node. */
export type LiteralNode =
  | NumberLiteralNode
  | TextLiteralNode
  | BooleanLiteralNode
  | InstantLiteralNode
  | DurationLiteralNode
  | ComplexLiteralNode;

/**
 * The `ComputedValue` a literal node denotes, as a new object on every call. Whichever authoring form a `complexLiteral` used (see the "Complex values" section of README.md), it is normalised here to the single rectangular `ComputedValue`, so nothing downstream (arithmetic, compare, memberOf, negate) ever sees a polar-authored value. Shared by the interpreter and the compiled path so a literal means one thing in both.
 */
export function literalValue(node: Readonly<LiteralNode>): ComputedValue {
  switch (node.kind) {
    case "numberLiteral":
      return { kind: "number", value: node.value, unit: node.unit };
    case "textLiteral":
      return { kind: "text", value: node.value };
    case "booleanLiteral":
      return { kind: "boolean", value: node.value };
    case "instantLiteral":
      return { kind: "instant", value: node.value };
    case "durationLiteral":
      return { kind: "duration", value: node.value, unit: node.unit };
    case "complexLiteral":
      if ("re" in node) {
        return { kind: "complex", re: node.re, im: node.im, unit: node.unit };
      }

      return complexFromPolar(node.magnitude, node.phase, node.unit);
    default:
      throw new Error("unreachable literal node kind");
  }
}
