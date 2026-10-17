import { describe, expect, it, vi } from "vitest";
import type { CliIo } from "../../cli/run";

// `evaluateDocument` never reports `unrepresentable` for a real tree (see its doc comment), so reaching the command's handling of it needs the library call replaced.
vi.mock("../../src/evaluate-document", () => ({
  evaluateDocument: () => ({
    outcome: "unrepresentable",
    issues: ["(result): the value is not a finite number"],
  }),
}));

const { EXIT_REJECTED, run } = await import("../../cli/run");

describe("trilean evaluate when the result cannot be written as JSON", () => {
  it("prints nothing on standard output, names the problem on standard error and exits 2", () => {
    let out = "";
    let err = "";
    const io: CliIo = {
      readText: () => '{"kind":"numberLiteral","value":1}',
      writeStdout: (text) => {
        out += text;
      },
      writeStderr: (text) => {
        err += text;
      },
      version: "0.0.0",
    };

    expect(run(["evaluate", "t.json"], io)).toBe(EXIT_REJECTED);
    expect(out).toBe("");
    expect(err).toBe("(result): the value is not a finite number\n");
  });
});
