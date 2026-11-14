import { readFileSync } from "node:fs";
import { chromium } from "playwright";
import { bundle, install, readTree, report } from "./host.mjs";

const dir = install(process.argv[2]);
const files = {
  "/": ["text/html", '<script type="module" src="/page.js"></script>'],
  "/page.js": [
    "text/javascript",
    await bundle(
      dir,
      "browser",
      ["browser"],
      'window.done = fetch("/tree.json").then((r) => r.json()).then((t) => prepare(t)(pkg));',
    ),
  ],
  "/tree.json": ["application/json", JSON.stringify(readTree())],
  "/trilean_regex_bg.wasm": [
    "application/wasm",
    readFileSync(
      `${dir}/node_modules/trilean-regex/dist/trilean_regex_bg.wasm`,
    ),
  ],
};
const browser = await chromium.launch();
const page = await browser.newPage();
await page.route("http://runner.test/**", (route) => {
  const [contentType, body] = files[
    new URL(route.request().url()).pathname
  ] ?? ["text/plain", ""];

  return route.fulfill({ contentType, body });
});
await page.goto("http://runner.test/");
// The module finishes after the page loads, since it waits for the wasm file.
await page.waitForFunction(() => window.done);
report("chromium", await page.evaluate(() => window.done));
await browser.close();
