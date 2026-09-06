import type { RegexNode, RepeatNode } from "./ast";
import { charClassMatches } from "./ast";

type CharTest = (codeUnit: number) => boolean;

/**
 * One state of the compiled automaton. `char` is the only kind that consumes input; every other kind is resolved away during epsilon-closure (see `closure` in `matcher.ts`) before a position is ever tested against an input character.
 *
 * `anchorStart`/`anchorEnd` are what let `^`/`$` live anywhere in the pattern -- inside a group, inside an alternation branch -- rather than only at the very start or end of the whole pattern text: they are ordinary epsilon transitions that the closure walk additionally gates on the absolute string position, so `^`'s condition ("this position is index 0 of the whole input") is checked at the moment the automaton would step through it, not baked into where `^` was allowed to appear syntactically.
 */
export type NfaState =
  | { kind: "char"; test: CharTest; to: number }
  | { kind: "split"; to1: number; to2: number }
  | { kind: "anchorStart"; to: number }
  | { kind: "anchorEnd"; to: number }
  | { kind: "match" };

export interface CompiledNfa {
  readonly states: readonly NfaState[];
  readonly start: number;
  readonly matchState: number;
}

interface PatchTarget {
  readonly state: number;
  readonly field: "to" | "to1" | "to2";
}

interface Frag {
  readonly start: number;
  readonly out: readonly PatchTarget[];
}

/**
 * Thompson construction: each AST node compiles to a fragment with one entry state and a list of dangling exits, and a parent node patches its children's exits to point at whatever comes next once it knows what that is. This is the standard technique (Thompson 1968; see also Cox, "Regular Expression Matching Can Be Simple And Fast") specifically because it never needs to look ahead -- a fragment is complete and correct in isolation, and composition is always "point these exits here," which is what keeps construction linear in pattern size even for deeply nested alternation and repetition.
 */
class NfaBuilder {
  private readonly states: NfaState[] = [];

  private add(state: NfaState): number {
    this.states.push(state);
    return this.states.length - 1;
  }

  private patch(targets: readonly PatchTarget[], target: number): void {
    for (const patchTarget of targets) {
      const state = this.states[patchTarget.state];
      if (state === undefined) continue;
      switch (patchTarget.field) {
        case "to":
          if (
            state.kind === "char" ||
            state.kind === "anchorStart" ||
            state.kind === "anchorEnd"
          ) {
            state.to = target;
          }
          break;
        case "to1":
          if (state.kind === "split") state.to1 = target;
          break;
        case "to2":
          if (state.kind === "split") state.to2 = target;
          break;
      }
    }
  }

  /** A fragment that matches the empty string unconditionally: both of a split's own branches dangle straight out, so whichever target they are later patched to is reached having consumed nothing. Used for `{0}`/`{0,0}` repetition, the one shape bounded repetition can produce that no other node kind already covers. */
  private emptyFrag(): Frag {
    const idx = this.add({ kind: "split", to1: -1, to2: -1 });
    return {
      start: idx,
      out: [
        { state: idx, field: "to1" },
        { state: idx, field: "to2" },
      ],
    };
  }

  private compileRepeat(node: RepeatNode): Frag {
    const { operand, min, max } = node;
    if (max === undefined) {
      // {min,} = operand^(min-1) . operand+ ; {0,} is exactly star.
      if (min === 0) return this.compileNode({ kind: "star", operand });
      const parts: RegexNode[] = [];
      for (let i = 0; i < min - 1; i += 1) parts.push(operand);
      parts.push({ kind: "plus", operand });
      return this.compileNode({ kind: "concat", operands: parts });
    }
    // {min,max}, both bounded: `min` mandatory copies, then (max - min) independently optional copies in sequence. Concatenated optionals of the same atom already produce exactly the counting language {0..(max-min)} repetitions -- each one independently consumes the atom or skips it, and NFA nondeterminism explores every combination -- so no further node kind is needed for the bounded tail.
    const parts: RegexNode[] = [];
    for (let i = 0; i < min; i += 1) parts.push(operand);
    for (let i = 0; i < max - min; i += 1) {
      parts.push({ kind: "optional", operand });
    }
    if (parts.length === 0) return this.emptyFrag();
    return this.compileNode({ kind: "concat", operands: parts });
  }

  compileNode(node: RegexNode): Frag {
    switch (node.kind) {
      case "literal": {
        const codeUnit = node.codeUnit;
        const idx = this.add({
          kind: "char",
          test: (unit) => unit === codeUnit,
          to: -1,
        });
        return { start: idx, out: [{ state: idx, field: "to" }] };
      }
      case "anyChar": {
        const idx = this.add({ kind: "char", test: () => true, to: -1 });
        return { start: idx, out: [{ state: idx, field: "to" }] };
      }
      case "charClass": {
        const idx = this.add({
          kind: "char",
          test: (unit) => charClassMatches(node, unit),
          to: -1,
        });
        return { start: idx, out: [{ state: idx, field: "to" }] };
      }
      case "anchorStart": {
        const idx = this.add({ kind: "anchorStart", to: -1 });
        return { start: idx, out: [{ state: idx, field: "to" }] };
      }
      case "anchorEnd": {
        const idx = this.add({ kind: "anchorEnd", to: -1 });
        return { start: idx, out: [{ state: idx, field: "to" }] };
      }
      case "concat": {
        if (node.operands.length === 0) return this.emptyFrag();
        const [first, ...rest] = node.operands;
        if (first === undefined) {
          throw new Error(
            "unreachable: a non-empty operands array always has a first element",
          );
        }
        let frag = this.compileNode(first);
        for (const operand of rest) {
          const next = this.compileNode(operand);
          this.patch(frag.out, next.start);
          frag = { start: frag.start, out: next.out };
        }
        return frag;
      }
      case "alternation": {
        const [first, ...rest] = node.branches;
        if (first === undefined) {
          throw new Error(
            "unreachable: AlternationNode always has at least two branches",
          );
        }
        let frag = this.compileNode(first);
        for (const branch of rest) {
          const next = this.compileNode(branch);
          const splitIdx = this.add({
            kind: "split",
            to1: frag.start,
            to2: next.start,
          });
          frag = { start: splitIdx, out: [...frag.out, ...next.out] };
        }
        return frag;
      }
      case "star": {
        const inner = this.compileNode(node.operand);
        const splitIdx = this.add({
          kind: "split",
          to1: inner.start,
          to2: -1,
        });
        this.patch(inner.out, splitIdx);
        return { start: splitIdx, out: [{ state: splitIdx, field: "to2" }] };
      }
      case "plus": {
        const inner = this.compileNode(node.operand);
        const splitIdx = this.add({
          kind: "split",
          to1: inner.start,
          to2: -1,
        });
        this.patch(inner.out, splitIdx);
        return { start: inner.start, out: [{ state: splitIdx, field: "to2" }] };
      }
      case "optional": {
        const inner = this.compileNode(node.operand);
        const splitIdx = this.add({
          kind: "split",
          to1: inner.start,
          to2: -1,
        });
        return {
          start: splitIdx,
          out: [...inner.out, { state: splitIdx, field: "to2" }],
        };
      }
      case "repeat":
        return this.compileRepeat(node);
      default:
        node satisfies never;
        throw new Error("unreachable regex node kind");
    }
  }

  build(root: RegexNode): CompiledNfa {
    const frag = this.compileNode(root);
    const matchState = this.add({ kind: "match" });
    this.patch(frag.out, matchState);
    return { states: this.states, start: frag.start, matchState };
  }
}

/** Compiles a `RegexNode` AST into a Thompson-construction NFA, ready for `matchesNfa` (see `matcher.ts`) to simulate. Construction is linear in the size of the AST -- bounded repetition is the only node kind that can multiply state count beyond that, by exactly the multiple its own bound names, which is a property of what `{n,m}` means rather than of this algorithm. */
export function compileToNfa(node: RegexNode): CompiledNfa {
  return new NfaBuilder().build(node);
}
