// node conformance/runner/node.mjs <package tarball>: the corpus against the package as installed, in Node.
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { install, readTree, report } from "./host.mjs";
import { prepare } from "./run.mjs";

const entry = createRequire(`${install(process.argv[2])}/x.js`).resolve("trilean-regex");
report("node", await prepare(readTree())(await import(pathToFileURL(entry).href)));
