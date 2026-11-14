import { fileURLToPath } from "node:url";
import {
  GENERATED_CORPUS_FILES,
  writeGeneratedCorpus,
} from "../src/test-support/generated-corpus";

/**
 * Writes the generated conformance files into `conformance/`: the corpus files made from the implementation, the fixtures for every constraint of the schema, and the generated index in the README. `--list` prints the generated corpus files instead, one per line, for the tool that writes the manifest. The unit test of the generator compares everything it writes with what is committed. Run through tsx from this package.
 */
if (process.argv.includes("--list")) {
  process.stdout.write(`${GENERATED_CORPUS_FILES.join("\n")}\n`);
} else {
  writeGeneratedCorpus(
    fileURLToPath(new URL("../../../conformance/", import.meta.url)),
  );
}
