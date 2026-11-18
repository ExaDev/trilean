import { describe, expect, it } from "vitest";
import computedValue from "../../../../conformance/trilean/validate/computed-value.json";
import evaluation from "../../../../conformance/trilean/validate/evaluation.json";
import schemaPipeline from "../../../../conformance/trilean/validate/schema-pipeline.json";
import tree from "../../../../conformance/trilean/validate/tree.json";
import * as trilean from "../../src/index";
import * as trileanZod from "../../src/zod";
import { run } from "../support/consumer-core.mjs";

/** The checks every host of the package runs, here in the Workers runtime, from the corpus's validate cases and the limits at their edges. The Workers runtime has the smallest stack and the least memory of the hosts the package supports, so the limits are tested here at the edge and not only in Node. */
describe("the reader under workerd", () => {
  const cases = [tree, computedValue, evaluation, schemaPipeline]
    .flatMap((file): unknown[] => file.cases)
    .filter((entry) => {
      const written = JSON.stringify(entry);

      return !written.includes("$number") && !written.includes("codeUnits");
    });

  it("passes the checks every host runs", () => {
    const { executed, failures } = run(trilean, cases);
    expect(failures).toEqual([]);
    expect(executed).toBeGreaterThan(cases.length);
  });

  // The same checks with every schema replaced by the Zod schema of trilean/zod that wraps it, so Zod and the module it hands each value to run together in the Workers runtime.
  it("passes the checks every host runs through the schemas of trilean/zod", () => {
    const { executed, failures } = run({ ...trilean, ...trileanZod }, cases);
    expect(failures).toEqual([]);
    expect(executed).toBeGreaterThan(cases.length);
  });
});
