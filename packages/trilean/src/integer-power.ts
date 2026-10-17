/**
 * `base` raised to a non-negative integer `exponent` by exponentiation by squaring: one squaring and at most one product per bit of the exponent, so the number of `multiply` calls grows with the logarithm of the exponent where repeated multiplication grows with the exponent itself (an exponent of 1e9 is a few dozen products rather than a billion). `identity` is the value of exponent zero and the start of the product; `multiply` must be associative, which squaring relies on. With a rounding `multiply` the grouping matters: squaring compounds a rounding error through each successive square, so its error grows in proportion to the exponent, and for large exponents the result is many times less accurate than a plain loop's, in exchange for work that does not grow with the exponent.
 *
 * The exponent is halved with `Math.floor(remaining / 2)` and tested for oddness with `% 2`, both exact for any finite double, including those past the largest safe integer, whose low bits are all zero. The last squaring is skipped, so no unused product is formed and a base too large to square is not squared once more than the result needs.
 */
export function powerByRepeatedSquaring<T>({
  base,
  exponent,
  identity,
  multiply,
}: {
  base: T;
  exponent: number;
  identity: T;
  multiply: (left: T, right: T) => T;
}): T {
  let result = identity;
  let factor = base;
  let remaining = exponent;
  while (remaining > 0) {
    if (remaining % 2 === 1) result = multiply(result, factor);
    remaining = Math.floor(remaining / 2);
    if (remaining > 0) factor = multiply(factor, factor);
  }

  return result;
}
