/**
 * H3 cells are stored as Postgres `bigint`. A cell index is 64 bits whose top
 * bit is reserved and always 0, so every valid cell is below 2^63 and fits a
 * signed bigint. h3-js writes cells as hexadecimal strings; these helpers
 * convert at the database boundary without passing through `Number`, which
 * would lose the low bits.
 */
const H3_CELL_HEX = /^[0-9a-f]{1,16}$/;

/** The decimal text of a cell's bigint, for a `$n::BIGINT` parameter. */
export function h3CellToBigint(cell: string): string {
  if (!H3_CELL_HEX.test(cell)) throw new Error(`Invalid H3 cell "${cell}"`);
  const value = BigInt(`0x${cell}`);
  if (value >= 2n ** 63n) throw new Error(`Invalid H3 cell "${cell}": the reserved bit is set`);
  return value.toString();
}

/** The hexadecimal cell h3-js uses, from a bigint read as text. */
export function h3CellFromBigint(value: string): string {
  if (!/^[0-9]+$/.test(value)) throw new Error(`Invalid H3 cell value "${value}"`);
  return BigInt(value).toString(16);
}
