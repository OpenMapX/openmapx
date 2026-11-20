const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const LONG_DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const DAY = DAYS.join("|");
const MONTH = MONTHS.join("|");
const TIME = "(\\d{2}):(\\d{2}):(\\d{2})";
// RFC 9110 §5.6.7: the preferred IMF-fixdate and the obsolete RFC 850 and asctime forms.
const IMF_FIXDATE = new RegExp(`^(${DAY}), (\\d{2}) (${MONTH}) (\\d{4}) ${TIME} GMT$`);
const RFC_850 = new RegExp(`^(${LONG_DAYS.join("|")}), (\\d{2})-(${MONTH})-(\\d{2}) ${TIME} GMT$`);
const ASCTIME = new RegExp(`^(${DAY}) (${MONTH}) ( \\d|\\d{2}) ${TIME} (\\d{4})$`);

interface DateFields {
  weekday: number;
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/**
 * RFC 850's two-digit year: a year more than 50 years ahead of now is the most
 * recent past year with the same last two digits (RFC 9110 §5.6.7).
 */
function fullYear(twoDigits: number, now: number): number {
  const current = new Date(now).getUTCFullYear();
  const year = current - (current % 100) + twoDigits;
  return year > current + 50 ? year - 100 : year;
}

function fields(text: string, now: number): DateFields | null {
  let match = IMF_FIXDATE.exec(text);
  if (match) {
    const [, weekday, day, month, year, hour, minute, second] = match;
    return {
      weekday: DAYS.indexOf(weekday ?? ""),
      year: Number(year),
      month: MONTHS.indexOf(month ?? ""),
      day: Number(day),
      hour: Number(hour),
      minute: Number(minute),
      second: Number(second),
    };
  }
  match = RFC_850.exec(text);
  if (match) {
    const [, weekday, day, month, year, hour, minute, second] = match;
    return {
      weekday: LONG_DAYS.indexOf(weekday ?? ""),
      year: fullYear(Number(year), now),
      month: MONTHS.indexOf(month ?? ""),
      day: Number(day),
      hour: Number(hour),
      minute: Number(minute),
      second: Number(second),
    };
  }
  match = ASCTIME.exec(text);
  if (match) {
    const [, weekday, month, day, hour, minute, second, year] = match;
    return {
      weekday: DAYS.indexOf(weekday ?? ""),
      year: Number(year),
      month: MONTHS.indexOf(month ?? ""),
      day: Number(day?.trim()),
      hour: Number(hour),
      minute: Number(minute),
      second: Number(second),
    };
  }
  return null;
}

/** An HTTP-date in any of its three forms as epoch milliseconds, or null. */
function httpDate(text: string, now: number): number | null {
  const date = fields(text, now);
  if (!date) return null;
  const at = Date.UTC(date.year, date.month, date.day, date.hour, date.minute, date.second);
  const parsed = new Date(at);
  // The round trip refuses normalised calendar dates (31 Sep), out-of-range
  // times and a weekday that does not match the date.
  return parsed.getUTCFullYear() === date.year &&
    parsed.getUTCMonth() === date.month &&
    parsed.getUTCDate() === date.day &&
    parsed.getUTCHours() === date.hour &&
    parsed.getUTCMinutes() === date.minute &&
    parsed.getUTCSeconds() === date.second &&
    parsed.getUTCDay() === date.weekday
    ? at
    : null;
}

export interface RetryAfterOptions {
  /** Clock reading for an HTTP-date value; defaults to `Date.now()`. */
  now?: number;
  /**
   * The response's `Date` header. An HTTP-date value is measured from it when
   * it is a valid date, so a skewed local clock does not stretch the wait.
   */
  serverDate?: string | null;
}

/**
 * The wait a `Retry-After` value asks for, in milliseconds: delta-seconds or
 * an HTTP-date (IMF-fixdate, RFC 850 or asctime), with a date already past
 * meaning no wait. Fractional seconds, which some servers send, round up to
 * the next whole second. Anything else, including negative seconds, is null.
 * Callers apply their own ceiling and fallback.
 */
export function parseRetryAfterMs(
  value: string | null | undefined,
  options: RetryAfterOptions = {},
): number | null {
  const text = value?.trim();
  if (!text) return null;
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const delay = Math.ceil(Number(text)) * 1000;
    return Number.isSafeInteger(delay) ? delay : null;
  }
  const now = options.now ?? Date.now();
  const at = httpDate(text, now);
  if (at === null) return null;
  const server = options.serverDate ? httpDate(options.serverDate.trim(), now) : null;
  return Math.max(0, at - (server ?? now));
}
