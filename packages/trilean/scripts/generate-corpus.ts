import { fileURLToPath } from "node:url";
import { writeGeneratedCorpus } from "../src/test-support/generated-corpus";

/** Writes the generated conformance files into `conformance/`; the unit test of the generator regenerates them and fails when they differ from what is committed. Run through tsx from this package. */
writeGeneratedCorpus(
  fileURLToPath(new URL("../../../conformance/", import.meta.url)),
);
