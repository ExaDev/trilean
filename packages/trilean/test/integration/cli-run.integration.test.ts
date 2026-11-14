import { describe, expect, it } from "vitest";
import { EXIT_DEFINITE, run } from "../../cli/run";

/**
 * What the command prints and returns is in the conformance corpus (`conformance/trilean/cli/cli-run.json`). The version is the one thing the command is given by its host rather than by its arguments and files, so a case has nowhere to state it.
 */
describe("trilean evaluate", () => {
  it("prints the version for --version", () => {
    let out = "";

    expect(
      run(["--version"], {
        readText: () => {
          throw new Error("no file is read");
        },
        writeStdout: (text) => {
          out += text;
        },
        writeStderr: () => undefined,
        version: "9.9.9",
      }),
    ).toBe(EXIT_DEFINITE);
    expect(out).toBe("9.9.9\n");
  });
});
