/* Writes tests/number-forms.txt: one line per double, `<its 64 bits as 16 hexadecimal digits> <the text JSON.stringify writes
   for it>`, the engine's own answer for the routine in `json_shape` to be held to.

   Run from the repository root with Node (V8's number to string is what the corpus format follows). The table was written with Node v26.13.0 and rewritten byte for byte, checked with `cmp`, under Node v22.23.4:

     node rust/crates/corpus-format/tests/number-forms.mjs > rust/crates/corpus-format/tests/number-forms.txt

   The doubles are fixed by this file (the edge values below, then ones from a seeded generator), so a rerun writes the same
   file; a test of the crate fails when a value named under `BOUNDARIES` is missing from it. */
const view = new DataView(new ArrayBuffer(8));
const lines = [];
const seen = new Set();
function add(value) {
  if (!Number.isFinite(value)) return;
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0).toString(16).padStart(16, "0");
  if (seen.has(bits)) return;
  seen.add(bits);
  lines.push(`${bits} ${JSON.stringify(value)}`);
}
const next = (value) => {
  view.setFloat64(0, value);
  view.setBigUint64(0, view.getBigUint64(0) + 1n);

  return view.getFloat64(0);
};
const previous = (value) => {
  view.setFloat64(0, value);
  view.setBigUint64(0, view.getBigUint64(0) - 1n);

  return view.getFloat64(0);
};

/* The values where JSON.stringify changes form or a shortest-digit routine is most likely to be wrong: the switch to and
   from exponent form on each side, the limits of exact integers, the smallest and largest doubles, and both neighbours of
   each. */
const BOUNDARIES = [
  1e-7,
  1e-6,
  1e21,
  1e20,
  123456789012345680000,
  2 ** 53 - 1,
  2 ** 53,
  2 ** 53 + 2,
  2 ** 53 + 4,
  2 ** 63,
  2 ** 64,
  2 ** 70,
  5e-324,
  2.2250738585072014e-308,
  2.225073858507201e-308,
  1.7976931348623157e308,
  0.1,
  0.2,
  0.3,
  0.1 + 0.2,
  4.35,
  0.5,
  1 / 3,
  2 / 3,
  100,
  1e300,
  9.999999999999999e22,
  1e22,
  1e23,
  8.41e21,
  5e-7,
  4.5e-7,
  9.5e-7,
  1.5e-6,
  Number.MIN_VALUE,
  Number.EPSILON,
  Number.MAX_SAFE_INTEGER,
  Number.MIN_SAFE_INTEGER,
];
for (const x of [0, 1, 2, 10, 1000, ...BOUNDARIES]) {
  for (const value of [x, previous(x), next(x)]) {
    add(value);
    add(-value);
  }
}
for (let e = -330; e <= 310; e++) {
  for (const text of [
    `1e${e}`,
    `9.999999999999999e${e}`,
    `5e${e}`,
    `1.7976931348623157e${e}`,
  ]) {
    const value = Number(text);
    add(value);
    add(previous(value));
    add(next(value));
  }
}
let state = 0x9e3779b97f4a7c15n;
const mask = (1n << 64n) - 1n;
function random() {
  state ^= (state << 13n) & mask;
  state ^= state >> 7n;
  state ^= (state << 17n) & mask;

  return state & mask;
}
for (let i = 0; i < 4000; i++) {
  view.setBigUint64(0, random());
  add(view.getFloat64(0));
}
for (let i = 0; i < 2000; i++) {
  const digits = 1 + Number(random() % 17n);
  const mantissa = (random() % 10n ** BigInt(digits)).toString();
  const exponent = Number(random() % 60n) - 30;
  add(Number(`${mantissa}e${exponent}`));
}
for (let i = 0; i < 1000; i++) {
  add(Number(random() % 100000n) / Number(1n + (random() % 1000n)));
}
process.stdout.write(lines.join("\n") + "\n");
