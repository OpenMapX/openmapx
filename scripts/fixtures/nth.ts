/** The element at `index`, counting back from the end for a negative one; throws when there is none. */
export function nth<T>(values: readonly T[], index: number): T {
  const value = values.at(index);
  if (value === undefined) throw new RangeError(`no element at ${index} of ${values.length}`);
  return value;
}
