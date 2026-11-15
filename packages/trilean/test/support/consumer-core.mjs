/**
 * What a consumer of the packed `trilean` checks, as plain JavaScript that runs in every host the package supports: a bundle in a browser, a bundle in Node, a Worker, and the package's own tests. It is handed the package (its public entry point as a module namespace) and the corpus cases to read, and it returns the failures it found, so the host does no more than print or return them.
 *
 * It covers the corpus's `validate` cases, a tree that reaches `trilean-regex` through `trilean` (so both wasm modules are started in the host), and the limits of the reader at the edge: the deepest value, the longest array, the costliest shape of tree at the depth limit, a sparse array that claims a length it does not hold, and a value that throws when it is read.
 */

/** The deepest nesting of arrays and objects `trilean` reads, and the most elements of an array: the limits its documentation states. */
export const MAX_NESTING_DEPTH = 500;
export const MAX_ARRAY_LENGTH = 65536;
export const MAX_STRING_UNITS = 1048576;
export const MAX_TEXT_UNITS = 4194304;

/** How many hostile values are read in a row, which would exhaust the module's stack if each leaked the frames it crossed, and the length of a sparse array small enough to be read. */
const HOSTILE_ROUNDS = 3000;
const SMALL_SPARSE = 10;
const SHARED_LEVELS = 40;

/** Lengths a hostile array claims while holding nothing: half the largest and the largest an array can have. */
const SPARSE_LENGTHS = { half: 0x80000000, most: 0xffffffff };

const nested = (containers, wrap, leaf) => {
  let value = leaf;
  for (let level = 0; level < containers; level += 1) {
    value = wrap(value);
  }

  return value;
};

const same = (a, b) => {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);

  return [...keys].every((key) => same(a[key], b[key]));
};

const decode = (value) =>
  Array.isArray(value)
    ? value.map(decode)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value).map(([key, entry]) => [key, decode(entry)]),
        )
      : value;

export function run(trilean, cases) {
  const failures = [];
  let executed = 0;
  const check = (name, ok, detail) => {
    executed += 1;
    if (!ok) failures.push(`${name}: ${detail}`);
  };
  const read = (schema, value) => trilean[schema]["~standard"].validate(value);
  const accepts = (schema, value) => read(schema, value).issues === undefined;
  const refusal = (schema, value) => {
    const result = read(schema, value);

    return result.issues === undefined ? undefined : result.issues[0];
  };

  for (const entry of cases) {
    const result = read(entry.schema, decode(entry.input));
    const accepted = result.issues === undefined;
    check(
      entry.id,
      accepted === entry.expect.ok &&
        (!accepted ||
          entry.expect.value === undefined ||
          same(result.value, entry.expect.value)),
      `${entry.schema} ${accepted ? "accepted" : "refused"} the input`,
    );
    if (!accepted && entry.expect.paths !== undefined) {
      const wanted = entry.expect.paths
        .map((path) => JSON.stringify(path))
        .sort();
      const found = [
        ...new Set(result.issues.map((issue) => JSON.stringify(issue.path))),
      ].sort();
      check(
        `${entry.id} paths`,
        same(found, wanted),
        `refused at ${found.join(" ")}`,
      );
    }
  }

  const document = trilean.evaluateDocument({
    tree: {
      kind: "textCompare",
      op: "portableMatches",
      left: { kind: "reference", key: "name" },
      right: { kind: "textLiteral", value: "^a+$" },
    },
    inputs: { name: { kind: "text", value: "aaa" } },
  });
  check(
    "a portable pattern through both modules",
    document.outcome === "evaluated" && document.evaluation.value === true,
    JSON.stringify(document),
  );

  check(
    "a value nested to the limit is read",
    accepts(
      "JsonValueSchema",
      nested(MAX_NESTING_DEPTH, (v) => [v], 1),
    ),
    "refused",
  );
  const tooDeep = refusal(
    "JsonValueSchema",
    nested(MAX_NESTING_DEPTH + 1, (v) => [v], 1),
  );
  check(
    "a value one level deeper is refused where it is too deep",
    tooDeep !== undefined && tooDeep.path.length === MAX_NESTING_DEPTH,
    JSON.stringify(tooDeep?.path.length),
  );
  const negations = (nodes) =>
    nested(nodes, (operand) => ({ kind: "negate", operand }), {
      kind: "numberLiteral",
      value: 1,
    });
  check(
    "the costliest tree at the limit is read",
    accepts("ExpressionNodeSchema", negations(MAX_NESTING_DEPTH - 1)),
    "refused",
  );
  check(
    "the costliest tree one node over the limit is refused",
    refusal("ExpressionNodeSchema", negations(MAX_NESTING_DEPTH)) !== undefined,
    "accepted",
  );
  const allOfs = (nodes) =>
    nested(nodes, (operand) => ({ kind: "allOf", operands: [operand] }), {
      kind: "exists",
      operand: { kind: "numberLiteral", value: 1 },
    });
  check(
    "a tree of arrays between its nodes is refused at the limit without a trap",
    refusal("PredicateNodeSchema", allOfs(MAX_NESTING_DEPTH)) !== undefined,
    "accepted",
  );

  check(
    "an array of the most elements is read",
    accepts("JsonValueSchema", new Array(MAX_ARRAY_LENGTH).fill(0)),
    "refused",
  );
  check(
    "an array one element over is refused at the array",
    refusal(
      "JsonValueSchema",
      new Array(MAX_ARRAY_LENGTH + 1).fill(0),
    )?.message.includes(String(MAX_ARRAY_LENGTH + 1)) === true,
    "accepted or refused for another reason",
  );
  for (const length of [SPARSE_LENGTHS.half, SPARSE_LENGTHS.most]) {
    const sparse = new Array(length);
    check(
      `a sparse array that claims ${length} elements is refused without an allocation`,
      refusal("JsonValueSchema", sparse)?.message.includes(String(length)) ===
        true,
      "accepted or refused for another reason",
    );
  }
  check(
    "a sparse array within the limit is refused at its first hole",
    JSON.stringify(
      refusal("JsonValueSchema", new Array(SMALL_SPARSE))?.path,
    ) === "[0]",
    "accepted or refused elsewhere",
  );

  const hostile = [
    [
      "an element that throws when read",
      () => {
        const array = [1];
        Object.defineProperty(array, 0, {
          get() {
            throw new Error("hostile");
          },
        });

        return array;
      },
    ],
    [
      "a member that throws when read",
      () => ({
        get a() {
          throw new Error("hostile");
        },
      }),
    ],
    [
      "a proxy whose keys throw",
      () =>
        new Proxy(
          {},
          {
            ownKeys() {
              throw new Error("hostile");
            },
          },
        ),
    ],
    [
      "a proxy whose prototype throws",
      () =>
        new Proxy(
          {},
          {
            getPrototypeOf() {
              throw new Error("hostile");
            },
          },
        ),
    ],
    [
      "an array proxy whose length throws",
      () =>
        new Proxy([], {
          get(target, key) {
            if (key === "length") {
              throw new Error("hostile");
            }

            return target[key];
          },
        }),
    ],
    [
      "an array proxy whose length is an object that does not convert",
      () =>
        new Proxy([], {
          get(target, key) {
            return key === "length"
              ? {
                  valueOf() {
                    throw new Error("hostile");
                  },
                }
              : target[key];
          },
        }),
    ],
    [
      "a revoked proxy",
      () => {
        const { proxy, revoke } = Proxy.revocable({}, {});
        revoke();

        return proxy;
      },
    ],
  ];
  for (const [name, make] of hostile) {
    let outcome;
    try {
      outcome = refusal("JsonValueSchema", make());
    } catch (error) {
      outcome = `threw ${String(error)}`;
    }
    check(
      `${name} is an issue and not an exception`,
      typeof outcome === "object",
      String(outcome),
    );
  }
  for (let round = 0; round < HOSTILE_ROUNDS; round += 1) {
    refusal("JsonValueSchema", hostile[0][1]());
  }
  check(
    "reading still works after the hostile values, and as deep as before",
    accepts(
      "JsonValueSchema",
      nested(MAX_NESTING_DEPTH, (v) => [v], 1),
    ),
    "the module's stack was not given back",
  );

  // A string named many times is copied at each place it is named, so the text of a read is counted: four strings of the longest length are read, a fifth is refused, and so is one string a unit longer than the longest.
  const longest = "a".repeat(MAX_STRING_UNITS);
  const named = (times) => new Array(times).fill(longest);
  const fits = MAX_TEXT_UNITS / MAX_STRING_UNITS;
  check(
    "the most text a read may hold is read",
    accepts("JsonValueSchema", named(fits)),
    "refused",
  );
  check(
    "one more string of the longest length is refused at the string that passes the limit",
    refusal("JsonValueSchema", named(fits + 1))?.path.join() === String(fits),
    "accepted or refused elsewhere",
  );
  check(
    "a string one unit over the longest is refused from its length",
    refusal("JsonValueSchema", longest + "a")?.message.includes(
      String(MAX_STRING_UNITS + 1),
    ) === true,
    "accepted or refused for another reason",
  );
  check(
    "an object key one unit over the longest is refused",
    refusal("JsonValueSchema", { [longest + "a"]: 1 }) !== undefined,
    "accepted",
  );

  // A value that names one array twice at each of forty levels has two to the fortieth places: it is refused once the count of values read passes the limit, and not read in full.
  let shared = [1];
  for (let level = 0; level < SHARED_LEVELS; level += 1) {
    shared = [shared, shared];
  }
  check(
    "a value that shares its parts is refused at the count of values",
    refusal("JsonValueSchema", shared)?.message.includes("values") === true,
    "accepted or refused for another reason",
  );

  const keys = refusal("JsonValueSchema", { "\ud800": 1, "\ud801": 2 });
  check(
    "object keys with an unpaired surrogate are refused, as string values are",
    keys !== undefined && keys.message.includes("key"),
    String(keys?.message),
  );

  return { executed, failures };
}
