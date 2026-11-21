/**
 * Reads a number used in arithmetic or comparisons from an array that an
 * algorithm sized and indexes itself. Callers stay within the bounds they
 * allocated; a position outside them reads as NaN, which is what the same
 * unchecked read produced in arithmetic: sums become NaN and comparisons
 * against it are false. NaN is not safe where the value becomes an index or
 * a loop condition; read those with `indexAt`, which throws instead.
 */
export function numberAt(values: ArrayLike<number>, index: number): number {
  return values[index] ?? Number.NaN;
}
