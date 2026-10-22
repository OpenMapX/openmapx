/**
 * Parse the nonnegative fixed elapsed subset PnDTnHnMnS into seconds.
 * Day/hour/minute fields are integers; seconds may have a decimal fraction.
 * A day is exactly 86400 seconds, independent of calendar/timezone arithmetic.
 * Calendar years/months, weeks, signs and incomplete designators are unsupported.
 * Returns undefined for unsupported syntax or a non-finite result; callers own
 * rounding, units and fallback policy. This is not a full ISO8601 duration parser.
 * Grammar reference: https://www.w3.org/TR/xmlschema11-2/#dayTimeDuration
 */
export function parseElapsedDurationSeconds(value: string | undefined): number | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(value);
  // JavaScript's $ also matches before a final newline; require the whole input.
  if (!match || match[0] !== value || value.endsWith("T")) return undefined;
  const [, days, hours, minutes, seconds] = match;
  if (days === undefined && hours === undefined && minutes === undefined && seconds === undefined) {
    return undefined;
  }
  const total =
    Number(days ?? 0) * 86400 +
    Number(hours ?? 0) * 3600 +
    Number(minutes ?? 0) * 60 +
    Number(seconds ?? 0);
  return Number.isFinite(total) ? total : undefined;
}
