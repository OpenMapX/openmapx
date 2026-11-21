/**
 * Reads an element the caller's own bounds guarantee: a loop index below the
 * length, a row of a query that always returns one, a position the caller
 * computed from the same array. A position with no element throws a
 * `RangeError`, because a miss means the caller's invariant is broken. A
 * negative position throws too rather than counting from the end, so a failed
 * search such as `findIndex` returning -1 cannot read the last element.
 * `what` names the element in that error, such as the query a row came from.
 * A list with holes the caller has filled, typed `(T | undefined)[]`, reads as
 * `T`, since an `undefined` element throws the same way.
 */
export function itemAt<T>(
  items: ArrayLike<T>,
  index: number,
  what = "item",
): NonNullable<T> | (T & null) {
  const item = items[index];
  if (item === undefined) {
    throw new RangeError(`No ${what} at position ${index} of ${items.length}`);
  }
  return item;
}
