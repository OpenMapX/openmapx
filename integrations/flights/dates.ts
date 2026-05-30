/** Date format helpers for provider URL builders. Inputs are `YYYY-MM-DD`. */

/**
 * `2026-06-15` → `260615`. Skyscanner's consumer URL path uses this 6-digit
 * `YYMMDD` form (its affiliate referral API, confusingly, uses `YYYY-MM-DD`).
 */
export function toYYMMDD(isoDate: string): string {
  const [y, m, d] = isoDate.split("-");
  return `${y.slice(2)}${m}${d}`;
}
