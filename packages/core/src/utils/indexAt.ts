/**
 * Reads an index that an algorithm stored in an array it sized itself, such as
 * a child node, an edge number or an assignment slot. A position outside the
 * array throws a `RangeError`: the value is used to index or to end a loop, and
 * NaN there would recurse or spin forever instead of failing.
 */
export function indexAt(values: ArrayLike<number>, index: number): number {
  const value = values[index];
  if (value === undefined) {
    throw new RangeError(`No index stored at position ${index} of ${values.length}`);
  }
  return value;
}
