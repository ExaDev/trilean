import type { Text } from "./corpus-types";

/**
 * The corpus carries every pattern, input and message fragment as a sequence of UTF-16 code units, either as a JSON string or as the code units themselves (`conformance/README.md`). A JavaScript string is already that sequence, so decoding is the identity for the first form and `String.fromCharCode` for the second.
 *
 * This file is a copy of `packages/trilean-regex/src/test-support/text.ts`, kept as a copy because both are deleted with the TypeScript they test; a change here is made in that file too.
 */

/** The string a corpus text denotes. */
export function textToString(text: Text): string {
  return typeof text === "string"
    ? text
    : String.fromCharCode(...text.codeUnits);
}

/** The UTF-16 code units a corpus text denotes. */
export function textToCodeUnits(text: Text): readonly number[] {
  if (typeof text !== "string") {
    return text.codeUnits;
  }

  return Array.from({ length: text.length }, (_, index) =>
    text.charCodeAt(index),
  );
}
