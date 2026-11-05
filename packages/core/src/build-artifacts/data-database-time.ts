/** PostgreSQL returns Date under the raw driver and dated strings under the
 * shared Drizzle driver. Neither representation supplies a missing timestamp. */
export function retainedDataDatabaseTimestamp(value: unknown): Date {
  if (
    !(value instanceof Date) &&
    !(
      typeof value === "string" &&
      /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::?\d{2})?)$/.test(
        value,
      )
    )
  )
    throw Error("Original dated database timestamp required");
  const result = new Date(value);
  if (!Number.isSafeInteger(result.getTime()) || result.getTime() < 0)
    throw Error("Invalid retained database timestamp");
  return result;
}
