/** `2 ** exponent` is infinite beyond 1023, so a scale factor is applied in two halves: each half is within range for every exponent a finite double can need, and a power of two multiplies a double exactly while the result stays normal. */
function scaleByPowerOfTwo(value: number, exponent: number): number {
  const firstHalf = Math.trunc(exponent / 2);

  return value * 2 ** firstHalf * 2 ** (exponent - firstHalf);
}

/**
 * The components of `dividend / divisor` for a non-zero divisor.
 *
 * The textbook route multiplies both sides by the divisor's conjugate and divides by `re^2 + im^2`, which overflows for a divisor near the top of the range and underflows for one near the bottom, even when the quotient is an ordinary number. Smith's algorithm avoids that for ordinary operands but still overflows its denominator or numerator above about 9e307 and loses accuracy for subnormal divisors, giving a wrong finite answer (zero for a quotient of about 0.07) rather than an error.
 *
 * Here both operands are first multiplied by the same power of two, chosen so the divisor's larger component lands in [0.25, 0.5). Scaling both by one factor leaves the quotient unchanged, and a power of two multiplies exactly, so the scaled divisor's squared magnitude is between about 0.06 and 0.5, which neither overflows nor underflows, and the scaled dividend is no larger than the quotient it produces, so it overflows only when the quotient does. The conjugate formula then runs on those scaled values. Its accuracy is the conjugate method's, a few units in the last place over the pair as a whole; a component much smaller than the other is accurate relative to the larger one, not to itself.
 *
 * A quotient that is too large for a double comes out as an infinity, left to the caller's finite check, and one below the smallest subnormal comes out as zero; a quotient in the subnormal range is rounded to the spacing of subnormals, like any result there.
 */
export function divideComplexComponents(
  dividend: Readonly<{ re: number; im: number }>,
  divisor: Readonly<{ re: number; im: number }>,
): { re: number; im: number } {
  const larger = Math.max(Math.abs(divisor.re), Math.abs(divisor.im));
  const scale = -Math.floor(Math.log2(larger)) - 2;
  const a = scaleByPowerOfTwo(dividend.re, scale);
  const b = scaleByPowerOfTwo(dividend.im, scale);
  const c = scaleByPowerOfTwo(divisor.re, scale);
  const d = scaleByPowerOfTwo(divisor.im, scale);
  const denominator = c * c + d * d;

  return {
    re: (a * c + b * d) / denominator,
    im: (b * c - a * d) / denominator,
  };
}
