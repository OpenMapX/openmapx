const WALL_CLOCK = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/;
const TIME_OF_DAY = /^(\d{2}):(\d{2})$/;

/**
 * A wall-clock date, date and time of day, or time of day alone
 * (`2026-12-24`, `2026-12-24T14:00`, `14:00`), in the reader's locale ("Dec
 * 24, 2026", "24.12.2026, 14:00", "2:00 PM"). It is formatted as it is
 * written, in UTC, so it is never shifted into the reader's time zone. Text
 * that is none of these is returned as it is.
 */
export function formatWallClock(value: string, locale: string): string {
  const time = TIME_OF_DAY.exec(value);
  if (time) {
    const at = Date.UTC(1970, 0, 1, Number(time[1]), Number(time[2]));
    return new Intl.DateTimeFormat(locale, { timeZone: "UTC", timeStyle: "short" }).format(at);
  }
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
