/**
 * Reads an element the caller's own bounds guarantee: a loop index below the
 * length, a row of a query that always returns one, a position the caller
 * computed from the same array. A position with no element throws a
 * `RangeError`, because a miss means the caller's invariant is broken. A
 * negative position throws too rather than counting from the end, so a failed
 * search such as `findIndex` returning -1 cannot read the last element.
 */
export function itemAt<T>(items: ArrayLike<T>, index: number): T {
  const item = items[index];
  if (item === undefined) {
    throw new RangeError(`No item at position ${index} of ${items.length}`);
  }
  return item;
}
