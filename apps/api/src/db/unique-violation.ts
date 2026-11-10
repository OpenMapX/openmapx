/**
 * True only for a unique violation (SQLSTATE 23505) raised by `constraint`.
 * Drivers and the ORM wrap the database error, so the `cause` chain is walked.
 * Every other database failure stays unrecognized and keeps its own handling.
 */
export function isUniqueViolation(error: unknown, constraint: string): boolean {
  let current = error;
  for (let depth = 0; depth < 8 && current && typeof current === "object"; depth++) {
    const item = current as { code?: unknown; constraint_name?: unknown; cause?: unknown };
    if (item.code === "23505" && item.constraint_name === constraint) return true;
    current = item.cause;
  }
  return false;
}
