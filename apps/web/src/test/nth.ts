/** The element at `index`, counting back from the end for a negative one; throws when there is none. */
export function nth<T>(values: ArrayLike<T>, index: number): T {
  const value = values[index < 0 ? values.length + index : index];
  if (value === undefined) throw new RangeError(`no element at ${index} of ${values.length}`);
  return value;
}
