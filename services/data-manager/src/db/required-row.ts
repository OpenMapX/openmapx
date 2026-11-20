/**
 * The row a query always returns, such as an aggregate, an `EXISTS` check, a
 * lock attempt or a singleton state row. A missing row means the database is
 * not in the shape the query expects, so it throws instead of reading fields
 * of `undefined`.
 */
export function requiredRow<T>(rows: readonly T[], query: string): T {
  const [row] = rows;
  if (row === undefined) throw new Error(`${query} returned no row`);
  return row;
}
