/** Date format helpers for provider URL builders. Inputs are `YYYY-MM-DD`. */

/**
 * `2026-06-15` → `260615`. Skyscanner's consumer URL path uses this 6-digit
 * `YYMMDD` form (its affiliate referral API, confusingly, uses `YYYY-MM-DD`).
 */
export function toYYMMDD(isoDate: string): string {
  const [y, m, d] = isoDate.split("-");
  if (y === undefined || m === undefined || d === undefined) {
    throw new RangeError(`Not a YYYY-MM-DD date: ${isoDate}`);
  }
  return `${y.slice(2)}${m}${d}`;
}
