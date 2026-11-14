// The core of the wasm runner, the same in every runtime: the corpus as a tree of files, the loader contract of ../README.md, the trilean-regex cases.
import Ajv from "ajv/dist/2020.js";

const NAME = /^[a-z0-9][a-z0-9._-]*$/;
const ROOT = [
  "README.md",
  "case.schema.json",
  "manifest.json",
  "manifest.schema.json",
];
const wf = (v) =>
  typeof v === "string"
    ? v.isWellFormed()
    : !v ||
      typeof v !== "object" ||
      Object.entries(v).every(([k, x]) => wf(k) && wf(x));
const bad = (n) =>
  !!n &&
  typeof n === "object" &&
  ((n.kind === "charClass" && n.ranges.some((r) => r.from > r.to)) ||
    (n.kind === "repeat" && n.max !== undefined && n.min > n.max) ||
    ["operand", "operands", "branches"].some((k) =>
      [].concat(n[k] ?? []).some(bad),
    ));
const units = (t) =>
  typeof t === "string" ? t : String.fromCharCode(...t.codeUnits);
const eq = (a, b) =>
  a === b ||
  (!!a &&
    !!b &&
    typeof a === "object" &&
    typeof b === "object" &&
    Array.isArray(a) === Array.isArray(b) &&
    Object.keys({ ...a, ...b }).every((k) => eq(a[k], b[k])));
const part = (a, e) =>
  Array.isArray(e)
    ? Array.isArray(a) &&
      a.length === e.length &&
      e.every((x, i) => part(a[i], x))
    : e && typeof e === "object"
      ? !!a && Object.entries(e).every(([k, x]) => part(a[k], x))
      : Object.is(a, e);
const sub = (tree, prefix) =>
  Object.fromEntries(
    Object.entries(tree)
      .filter(([p]) => p.startsWith(prefix))
      .map(([p, t]) => [p.slice(prefix.length), t]),
  );
const names = (tree, dir) =>
  [...new Set(Object.keys(sub(tree, dir)).map((p) => p.split("/")[0]))].sort();

/**
 * The one file selection rule: a corpus file is <package>/<area>/<name>.json, and anything unexpected is a problem.
 */
export function select(tree) {
  const kids = new Map();
  for (const [p, t] of Object.entries(tree)) {
    const s = p.split("/");
    s.forEach((n, i) =>
      kids.set(
        s.slice(0, i).join("/"),
        (kids.get(s.slice(0, i).join("/")) ?? new Map()).set(
          n,
          i < s.length - 1 ? "dir" : t === false ? "other" : "file",
        ),
      ),
    );
  }
  const out = { selected: [], problems: [] };
  const scan = (dir, depth) => {
    for (const [n, type] of [...(kids.get(dir) ?? [])].sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    )) {
      const path = dir ? `${dir}/${n}` : n;
      if (
        n.startsWith(".") ||
        (type === "dir" && ["fixtures", "schema", "runner"].includes(n)) ||
        (type === "file" && depth === 0 && ROOT.includes(n))
      )
        continue;
      if (type === "dir" && depth < 2 && NAME.test(n)) scan(path, depth + 1);
      else if (
        type === "file" &&
        depth === 2 &&
        n.endsWith(".json") &&
        NAME.test(n)
      )
        out.selected.push(path);
      else out.problems.push(path);
    }
  };
  scan("", 0);

  return out;
}

export function prepare(tree) {
  // Ajv compiles code, which a Workers isolate allows only at startup: prepare before serving.
  const ajv = new Ajv({ allErrors: true, strict: true, allowUnionTypes: true });
  const [vFile, vManifest] = ["case", "manifest"].map((n) =>
    ajv.compile(JSON.parse(tree[`${n}.schema.json`])),
  );
  const parse = (text) => {
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  };
  const check = (text, validate) => {
    const v = typeof text === "string" ? parse(text) : undefined;
    if (v === undefined) return ["is not UTF-8 JSON"];
    if (!wf(v)) return ["holds an unpaired surrogate"];
    if (!validate(v)) return [ajv.errorsText(validate.errors)];

    return [];
  };
  const fileProblems = (text) => {
    const p = check(text, vFile),
      cases = parse(text)?.cases ?? [];

    return p.length
      ? p
      : [...new Set(cases.map((c) => c.id))].length < cases.length
        ? ["repeats an id"]
        : cases.some((c) => c.kind === "regex-parse" && bad(c.expect.ast))
          ? ["has a reversed range or bound"]
          : [];
  };
  const manifestProblems = (text) => {
    const p = check(text, vManifest);

    return p.length
      ? p
      : Object.values(parse(text).files).some((e) =>
            e.skip.some((id, i) => i && e.skip[i - 1] >= id),
          )
        ? ["skip is not ascending"]
        : [];
  };
  const corpus = (t) => {
    const s = select(t),
      problems = s.problems.map((p) => `${p} is not a corpus file`),
      ids = new Set(),
      files = {};
    for (const n of s.selected) {
      const p = fileProblems(t[n]);
      problems.push(...p.map((x) => `${n} ${x}`));
      if (p.length) continue;
      const cases = parse(t[n]).cases;
      cases.forEach((c) => {
        if (ids.has(c.id)) problems.push(`${n}: id ${c.id} is in another file`);
        ids.add(c.id);
      });
      files[n] = {
        cases: cases.length,
        skip: cases
          .filter((c) => c.skip)
          .map((c) => c.id)
          .sort(),
      };
    }
    const m = manifestProblems(t["manifest.json"]);
    problems.push(...m.map((x) => `manifest.json ${x}`));
    if (!m.length) {
      const rec = Object.fromEntries(
        Object.entries(parse(t["manifest.json"]).files).map(([n, e]) => [
          n,
          { cases: e.cases, skip: e.skip },
        ]),
      );
      for (const n of new Set([...Object.keys(rec), ...Object.keys(files)]))
        if (!eq(rec[n], files[n]))
          problems.push(`manifest.json does not match ${n}`);
    }

    return problems;
  };
  const text = (d, n) => tree[`fixtures/${d}/${n}`];
  const pairs = (bd, gd, probs) =>
    names(tree, `fixtures/${bd}/`)
      .flatMap((n) => [
        probs(text(bd, n)).length ? [] : [`${bd}/${n} validates`],
        probs(text(gd, n)).length ? [`${gd}/${n} is rejected`] : [],
      ])
      .flat()
      .concat(
        eq(names(tree, `fixtures/${bd}/`), names(tree, `fixtures/${gd}/`))
          ? []
          : [`${bd} and ${gd} differ`],
      );
  const loaders = () => {
    const out = [],
      want = parse(tree["fixtures/loader-selection/expected.json"]);
    if (
      !eq(select(sub(tree, "fixtures/loader-selection/tree/")), {
        selected: want.selected,
        problems: want.problems,
      })
    )
      out.push("the selection rule disagrees with loader-selection");
    out.push(
      ...pairs("invalid-cases", "repaired-cases", fileProblems),
      ...pairs("refused-kinds/invalid", "refused-kinds/repaired", fileProblems),
      ...pairs("manifests/invalid", "manifests/repaired", manifestProblems),
    );
    for (const n of names(tree, "fixtures/valid-cases/"))
      if (fileProblems(text("valid-cases", n)).length)
        out.push(`valid-cases/${n} is rejected`);
    for (const n of names(tree, "fixtures/manifests/valid/"))
      if (manifestProblems(text("manifests/valid", n)).length)
        out.push(`manifests/valid/${n} is rejected`);
    for (const n of names(tree, "fixtures/corpora/invalid/")) {
      if (!corpus(sub(tree, `fixtures/corpora/invalid/${n}/`)).length)
        out.push(`corpora/invalid/${n} has no problem`);
      out.push(
        ...corpus(sub(tree, `fixtures/corpora/repaired/${n}/`)).map(
          (x) => `corpora/repaired/${n}: ${x}`,
        ),
      );
    }
    for (const p of parse(text("text-forms", "pairs.json")).pairs)
      if (
        units(p.text) !== units({ codeUnits: p.codeUnits }) ||
        units(p.text).length !== p.codeUnits.length
      )
        out.push(`text form ${p.text}`);

    return out;
  };
  const failures = [...corpus(tree), ...loaders()];
  const manifest = parse(tree["manifest.json"]).files;

  return async (pkg) => {
    let executed = 0,
      skipped = 0;
    const regexFiles = Object.keys(manifest).filter((n) =>
      n.startsWith("trilean-regex/"),
    );
    for (const name of regexFiles) {
      for (const c of parse(tree[name]).cases) {
        // Only a `rust` mark skips here; the native runner alone counts a `workBound`.
        if (c.skip === "rust") {
          skipped++;
          continue;
        }
        executed++;
        try {
          run(pkg, c);
        } catch (e) {
          failures.push(`${c.id}: ${e.message}`);
        }
      }
    }
    // Refusals are not corpus cases: check the class thrown through the boundary.
    for (const [p, index, construct] of [
      [".", 0, "."],
      ["a\\s", 1, "\\s"],
      ["[\\s]", 1, "\\s"],
      ["x|{2}", 2, "{"],
    ]) {
      try {
        pkg.compileEcmascriptSubset(p);
        failures.push(`${p} compiled`);
      } catch (e) {
        if (!(
          e instanceof pkg.UnsupportedConstructError &&
          e.index === index &&
          e.construct === construct
        ))
          failures.push(`${p}: ${e}`);
      }
    }
    const total = regexFiles.reduce((n, f) => n + manifest[f].cases, 0);
    if (executed + skipped !== total)
      failures.push(
        `executed ${executed} plus skipped ${skipped} is not the manifest's ${total}`,
      );

    return { executed, skipped, failures };
  };
}

function run(pkg, c) {
  const pattern = units(c.pattern),
    is = (v, w, s) => {
      if (v !== w)
        throw new Error(
          `${s}: ${JSON.stringify(v)}, expected ${JSON.stringify(w)}`,
        );
    };
  if (c.kind === "regex-match") {
    const compile =
        c.dialect === "ecmascript"
          ? pkg.compileEcmascriptSubset
          : pkg.compilePattern,
      once = compile(pattern);
    for (const { input, matches } of c.inputs) {
      const text = units(input);
      is(
        once.test(text),
        matches,
        `compiled once, input ${JSON.stringify(text)}`,
      );
      is(compile(pattern).test(text), matches, "compiled per call");
      if (c.dialect !== "ecmascript")
        is(pkg.testPattern(pattern, text), matches, "testPattern");
    }

    return;
  }
  let node, error;
  try {
    node = pkg.parseRegex(pattern);
  } catch (e) {
    error = e;
  }
  const { ast, astSubset, error: want } = c.expect;
  if (want === undefined) {
    if (error) throw error;
    if (!(ast ? eq(node, ast) : part(node, astSubset)))
      throw new Error(`parsed to ${JSON.stringify(node)}`);

    return;
  }
  if (!(error instanceof pkg.RegexParseError))
    throw new Error("the pattern parsed, or threw another error");
  if (want.index !== undefined) is(error.index, want.index, "index");
  const head = `invalid pattern at index ${error.index}: `,
    reason = error.message.slice(head.length, error.message.indexOf("\n")),
    at = (from, f) => reason.indexOf(units(f), from);
  let from = 0;
  for (const f of want.message ?? []) {
    const i = at(from, f);
    if (i < 0)
      throw new Error(
        `reason ${JSON.stringify(reason)} lacks ${JSON.stringify(units(f))} in order`,
      );
    from = i + units(f).length;
  }
}
