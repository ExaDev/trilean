/**
 * `value * 2 ** exponent`, applied in two halves because `2 ** exponent` is infinite beyond 1023 and a quotient can need a shift of about twice that. A power of two multiplies a double exactly while the result stays normal, so when the result can be non-zero and finite (a shift between about -1077 and 1024 for a scaled quotient of order one) each half is at most about 540 in magnitude, the first multiplication is exact, and the second is the one rounding, subnormal results included. Outside that range the result overflows or is below the smallest subnormal, and the halves give an infinity or zero, which is correct.
 */
function scaleByPowerOfTwo(value: number, exponent: number): number {
  const firstHalf = Math.trunc(exponent / 2);

  return value * 2 ** firstHalf * 2 ** (exponent - firstHalf);
}

/** The power of two that brings the larger of two magnitudes to about a quarter. `Math.log2` is rounded, so for a magnitude just under a power of two the result can land on either side of it, which is why the target is "about" a quarter. The magnitude must be non-zero. */
function scaleToAboutAQuarter(larger: number): number {
  return -Math.floor(Math.log2(larger)) - 2;
}

/**
 * The components of `dividend / divisor` for a non-zero divisor.
 *
 * The textbook route multiplies both sides by the divisor's conjugate and divides by `re^2 + im^2`, which overflows for a divisor near the top of the range and underflows for one near the bottom, even when the quotient is an ordinary number. Smith's algorithm avoids that for ordinary operands but still overflows its denominator or numerator above about 9e307 and loses accuracy for subnormal divisors, giving a wrong finite answer (zero for a quotient of about 0.07) rather than an error.
 *
 * Here the divisor is multiplied by a power of two that brings its larger component to about a quarter, and the dividend by its own power of two that does the same for its larger component. The conjugate formula then runs on those two scaled values, whose products are all of order one, so nothing in it overflows or underflows. The scaled quotient is the true quotient divided by `2 ** (dividendScale - divisorScale)`, so that power of two is applied to the result once, as the only step that can round beyond the formula's own few roundings.
 *
 * Accuracy: where the quotient is a normal number the error over the pair is a few units of 2^-53 (the measured worst case over a large exact-rational check is under 4), and a component much smaller than the other is accurate relative to the larger one, not to itself. Where the quotient lies in the subnormal range, results are within a few spacings of the true value (the measured worst case is under 5), not correctly rounded. A quotient too large for a double comes out with a non-finite component (an infinity, or NaN when the other component is zero), left to the caller's finite check, and one below half the smallest subnormal comes out as zero.
 */
export function divideComplexComponents(
  dividend: Readonly<{ re: number; im: number }>,
  divisor: Readonly<{ re: number; im: number }>,
): { re: number; im: number } {
  const largerDividend = Math.max(Math.abs(dividend.re), Math.abs(dividend.im));
  if (largerDividend === 0) return { re: 0, im: 0 };
  const largerDivisor = Math.max(Math.abs(divisor.re), Math.abs(divisor.im));
  const dividendScale = scaleToAboutAQuarter(largerDividend);
  const divisorScale = scaleToAboutAQuarter(largerDivisor);
  const a = scaleByPowerOfTwo(dividend.re, dividendScale);
  const b = scaleByPowerOfTwo(dividend.im, dividendScale);
  const c = scaleByPowerOfTwo(divisor.re, divisorScale);
  const d = scaleByPowerOfTwo(divisor.im, divisorScale);
  const denominator = c * c + d * d;
  const shift = divisorScale - dividendScale;

  return {
    re: scaleByPowerOfTwo((a * c + b * d) / denominator, shift),
    im: scaleByPowerOfTwo((b * c - a * d) / denominator, shift),
  };
}
