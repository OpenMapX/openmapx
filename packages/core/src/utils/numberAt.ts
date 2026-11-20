/**
 * Reads a number from an array that an algorithm sized and indexes itself.
 * Callers stay within the bounds they allocated; an index outside them reads
 * as NaN, which is what the same unchecked read produced in arithmetic, so
 * comparisons against it stay false and results are unchanged.
 */
export function numberAt(values: ArrayLike<number>, index: number): number {
  return values[index] ?? Number.NaN;
}
