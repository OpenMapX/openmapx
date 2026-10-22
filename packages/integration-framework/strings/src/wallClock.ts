const WALL_CLOCK = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/;

/**
 * A wall-clock date, or date and time of day (`2026-12-24`,
 * `2026-12-24T14:00`), in the reader's locale ("Dec 24, 2026", "24.12.2026,
 * 14:00"). It is formatted as it is written, in UTC, so it is never shifted
 * into the reader's time zone. Text that is not one is returned as it is.
 */
export function formatWallClock(value: string, locale: string): string {
  const match = WALL_CLOCK.exec(value);
  if (!match) return value;
  const [, year, month, day, hour, minute] = match;
  const at = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    hour === undefined ? 0 : Number(hour),
    minute === undefined ? 0 : Number(minute),
  );
  if (!Number.isFinite(at)) return value;
  return new Intl.DateTimeFormat(locale, {
    timeZone: "UTC",
    dateStyle: "medium",
    ...(hour === undefined ? {} : { timeStyle: "short" }),
  }).format(at);
}
