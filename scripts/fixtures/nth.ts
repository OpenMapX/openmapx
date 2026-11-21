/**
 * The element at `index`, read like `Array.prototype.at` (a negative index counts
 * from the end); throws a `RangeError` when there is none. Every package's test
 * `nth` keeps this contract.
 */
export function nth<T>(values: ArrayLike<T>, index: number): T {
  const value: T | undefined = Array.prototype.at.call(values, index);
  if (value === undefined) throw new RangeError(`no element at ${index} of ${values.length}`);
  return value;
}
